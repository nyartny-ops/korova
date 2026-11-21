package korova

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
)

const nodeKeyPrefix = "korova-node:"

// nodeKey is what `korova.sh install node` prints: everything the master needs in one line.
type nodeKey struct {
	Version int    `json:"v"`
	Name    string `json:"n"`
	Address string `json:"a"`
	Port    int    `json:"p"`
	Base    string `json:"b"`
	Token   string `json:"t"`
	Pin     string `json:"f"`
	// Public is set for tunnelled nodes: Address is then 127.0.0.1 on this panel.
	Public string `json:"pa"`
}

func decodeNodeKey(raw string) (*nodeKey, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, nodeKeyPrefix)
	raw = strings.Join(strings.Fields(raw), "")
	if raw == "" {
		return nil, errors.New("вставь ключ узла — его выводит установка узла или команда korova token")
	}
	var data []byte
	var err error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if data, err = enc.DecodeString(raw); err == nil {
			break
		}
	}
	if err != nil {
		return nil, errors.New("ключ узла повреждён: скопируй его целиком, одной строкой")
	}
	k := &nodeKey{}
	if err := json.Unmarshal(data, k); err != nil || k.Address == "" || k.Token == "" {
		return nil, errors.New("это не ключ узла Korova")
	}
	if k.Port == 0 {
		k.Port = 2053
	}
	return k, nil
}

func uniqueNodeName(want string) string {
	want = strings.TrimSpace(want)
	if want == "" {
		want = "node"
	}
	name := want
	for i := 2; i < 100; i++ {
		var n int64
		database.GetDB().Model(&model.Node{}).Where("name = ?", name).Count(&n)
		if n == 0 {
			return name
		}
		name = fmt.Sprintf("%s-%d", want, i)
	}
	return name
}

type ConnectNodeRequest struct {
	Key        string      `json:"key"`
	Name       string      `json:"name"`
	Force      bool        `json:"force"`
	Publish    bool        `json:"publish"`
	Country    string      `json:"country"`
	Look       InboundLook `json:"look"`
	Via        int         `json:"viaServerId"`
	KeepDirect bool        `json:"keepDirect"`
}

type ConnectNodeResult struct {
	Id          int    `json:"id"`
	Name        string `json:"name"`
	Address     string `json:"address"`
	Reachable   bool   `json:"reachable"`
	ProbeError  string `json:"probeError"`
	NeedConfirm bool   `json:"needConfirm"`
	Published   bool   `json:"published"`
	ServerName  string `json:"serverName"`
	PublishErr  string `json:"publishError"`
	RouteErr    string `json:"routeError"`
}

// ConnectNode adds a node from its one-line key. An unreachable node is only
// saved when the admin confirms (Force), so typos do not leave dead nodes behind.
func (s *Service) ConnectNode(req ConnectNodeRequest) (*ConnectNodeResult, error) {
	k, err := decodeNodeKey(req.Key)
	if err != nil {
		return nil, err
	}
	tunnel := k.Public != ""
	// The certificate pin identifies a node across address changes (direct -> tunnel).
	var existing model.Node
	found := false
	if k.Pin != "" {
		found = database.GetDB().Where("pinned_cert_sha256 = ?", k.Pin).First(&existing).Error == nil
	}
	if !found {
		var exists int64
		database.GetDB().Model(&model.Node{}).Where("address = ? AND port = ?", k.Address, k.Port).Count(&exists)
		if exists > 0 {
			return nil, fmt.Errorf("узел %s:%d уже подключён — он есть в списке «Узлы»", k.Address, k.Port)
		}
	}

	name := req.Name
	if strings.TrimSpace(name) == "" {
		name = k.Name
	}
	token := k.Token
	nodeName := uniqueNodeName(name)
	if found {
		nodeName = existing.Name
	}
	nodeReq := &service.NodeMutationRequest{
		Name:             nodeName,
		Remark:           "Подключён ключом Korova",
		Scheme:           "https",
		Address:          k.Address,
		Port:             k.Port,
		BasePath:         k.Base,
		ApiToken:         &token,
		Enable:           true,
		TlsVerifyMode:    "pin",
		PinnedCertSha256: k.Pin,
		InboundSyncMode:  "all",
		// Tunnelled nodes live on loopback here; the panel must be allowed to dial it.
		AllowPrivateAddress: tunnel,
	}
	if k.Pin == "" {
		nodeReq.TlsVerifyMode = "skip"
	}

	var ns service.NodeService
	shown := k.Address
	if tunnel {
		shown = k.Public + " (через туннель)"
	}
	res := &ConnectNodeResult{Name: nodeReq.Name, Address: shown}
	probeNode, err := ns.RuntimeNodeFromRequest(0, nodeReq)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	_, probeErr := ns.Probe(ctx, probeNode)
	cancel()
	if probeErr == nil {
		res.Reachable = true
	} else {
		res.ProbeError = service.FriendlyProbeError(probeErr.Error())
		if !req.Force {
			res.NeedConfirm = true
			return res, nil
		}
	}

	if found {
		if err := ns.UpdateFromRequest(existing.Id, nodeReq); err != nil {
			return nil, err
		}
		res.Id = existing.Id
	} else {
		view, err := ns.CreateFromRequest(nodeReq)
		if err != nil {
			return nil, err
		}
		res.Id = view.Id
	}
	if err := database.GetDB().Model(&model.Node{}).Where("id = ?", res.Id).
		Update("public_address", k.Public).Error; err != nil {
		return res, err
	}
	if req.Publish {
		srv, pErr := s.PublishServer(PublishRequest{NodeID: res.Id, Name: req.Name, Country: req.Country, Look: req.Look, Via: req.Via, KeepDirect: req.KeepDirect})
		var routeErr ErrRoute
		if errors.As(pErr, &routeErr) {
			res.Published = true
			res.ServerName = displayName(srv)
			res.RouteErr = routeErr.Err.Error()
		} else if pErr != nil {
			res.PublishErr = pErr.Error()
		} else {
			res.Published = true
			res.ServerName = displayName(srv)
		}
	}
	return res, nil
}

// buildRepo is stamped by the GitHub build (-ldflags -X) with the repository it was built from.
var buildRepo = "nyartny-ops/korova"

// NodeInstallCommand is the one-liner shown in the panel.
func NodeInstallCommand() string {
	repo := strings.TrimSpace(os.Getenv("KOROVA_REPO"))
	if repo == "" {
		repo = buildRepo
	}
	return fmt.Sprintf("bash <(curl -fsSL https://github.com/%s/releases/download/korova-latest/korova.sh) install node", repo)
}
