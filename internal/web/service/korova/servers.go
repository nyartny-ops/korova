package korova

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/curve25519"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
)

// serversMu serialises server/route changes: each one edits inbounds,
// cascades and the subscription list together.
var serversMu sync.Mutex

const defaultSNI = "www.microsoft.com"

var (
	nodePorts = []int{443, 8443, 9443, 10443, 11443, 12443, 13443}
	// 443 on the main server belongs to Caddy (panel + subscriptions).
	mainPorts = []int{8443, 9443, 10443, 11443, 12443, 13443}
)

// InboundLook is the part of a server's connection the admin may tune to get
// through blocking: transport, the disguise domain and the port.
type InboundLook struct {
	Transport string `json:"transport"`
	SNI       string `json:"sni"`
	Port      int    `json:"port"`
}

func (l InboundLook) normalized() InboundLook {
	switch l.Transport {
	case "xhttp", "grpc":
	default:
		l.Transport = "tcp"
	}
	l.SNI = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(l.SNI, "https://"), "http://"))
	l.SNI = strings.TrimSuffix(l.SNI, "/")
	if i := strings.Index(l.SNI, ":"); i >= 0 {
		l.SNI = l.SNI[:i]
	}
	if l.SNI == "" {
		l.SNI = defaultSNI
	}
	return l
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func x25519Pair() (priv, pub string, err error) {
	k := make([]byte, curve25519.ScalarSize)
	if _, err = rand.Read(k); err != nil {
		return "", "", err
	}
	k[0] &= 248
	k[31] &= 127
	k[31] |= 64
	p, err := curve25519.X25519(k, curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(k), base64.RawURLEncoding.EncodeToString(p), nil
}

func firstUserID() int {
	var u model.User
	if database.GetDB().Order("id asc").First(&u).Error != nil {
		return 1
	}
	return u.Id
}

// streamFor builds Reality stream settings, keeping an existing key pair when
// the inbound is only being retuned (clients keep working with the same keys).
func streamFor(look InboundLook, old map[string]any) (string, error) {
	look = look.normalized()
	priv, pub, shortID := "", "", ""
	if rs, ok := old["realitySettings"].(map[string]any); ok {
		priv, _ = rs["privateKey"].(string)
		if ids, ok := rs["shortIds"].([]any); ok && len(ids) > 0 {
			shortID, _ = ids[0].(string)
		}
		if st, ok := rs["settings"].(map[string]any); ok {
			pub, _ = st["publicKey"].(string)
		}
	}
	if priv == "" || pub == "" {
		var err error
		if priv, pub, err = x25519Pair(); err != nil {
			return "", err
		}
	}
	if shortID == "" {
		shortID = randHex(8)
	}
	stream := map[string]any{
		"network":       look.Transport,
		"security":      "reality",
		"externalProxy": []any{},
		"realitySettings": map[string]any{
			"show": false, "xver": 0,
			"target":       look.SNI + ":443",
			"serverNames":  []string{look.SNI},
			"privateKey":   priv,
			"minClientVer": "", "maxClientVer": "", "maxTimediff": 0,
			"shortIds":    []string{shortID},
			"mldsa65Seed": "",
			"settings": map[string]any{
				"publicKey": pub, "fingerprint": "chrome", "serverName": "", "spiderX": "/", "mldsa65Verify": "",
			},
		},
	}
	switch look.Transport {
	case "xhttp":
		path := "/" + randHex(6)
		if x, ok := old["xhttpSettings"].(map[string]any); ok {
			if p, ok := x["path"].(string); ok && p != "" {
				path = p
			}
		}
		stream["xhttpSettings"] = map[string]any{
			"path": path, "host": "", "mode": "auto", "headers": map[string]any{},
			"xPaddingBytes": "100-1000", "noSSEHeader": false, "scMaxBufferedPosts": 30,
			"scMaxEachPostBytes": "1000000", "scStreamUpServerSecs": "20-80",
		}
	case "grpc":
		name := randHex(5)
		if g, ok := old["grpcSettings"].(map[string]any); ok {
			if n, ok := g["serviceName"].(string); ok && n != "" {
				name = n
			}
		}
		stream["grpcSettings"] = map[string]any{"serviceName": name, "authority": "", "multiMode": false}
	default:
		stream["tcpSettings"] = map[string]any{"acceptProxyProtocol": false, "header": map[string]any{"type": "none"}}
	}
	b, err := json.Marshal(stream)
	return string(b), err
}

func portList(nodeID, want int) []int {
	if want > 0 {
		return []int{want}
	}
	if nodeID == 0 {
		return mainPorts
	}
	return nodePorts
}

// createRealityInbound adds a VLESS + Reality inbound — the same thing an admin
// would click together in «Входящие» — trying ports until one is free.
func (s *Service) createRealityInbound(nodeID int, remark string, look InboundLook) (*model.Inbound, error) {
	look = look.normalized()
	stream, err := streamFor(look, nil)
	if err != nil {
		return nil, err
	}
	settings, _ := json.Marshal(map[string]any{"clients": []any{}, "decryption": "none", "fallbacks": []any{}})
	sniffing, _ := json.Marshal(map[string]any{
		"enabled": true, "destOverride": []string{"http", "tls", "quic"}, "metadataOnly": false, "routeOnly": false,
	})
	var lastErr error
	for _, port := range portList(nodeID, look.Port) {
		ib := &model.Inbound{
			UserId:         firstUserID(),
			Remark:         remark,
			Enable:         true,
			Port:           port,
			Protocol:       model.VLESS,
			Settings:       string(settings),
			StreamSettings: stream,
			Sniffing:       string(sniffing),
			TrafficReset:   "never",
			SubSortIndex:   1,
			DisableFlow:    look.Transport != "tcp",
		}
		if nodeID > 0 {
			id := nodeID
			ib.NodeID = &id
		}
		created, needRestart, err := s.inboundSvc.AddInbound(ib)
		if needRestart {
			s.xraySvc.SetToNeedRestart()
		}
		if err == nil {
			return created, nil
		}
		lastErr = err
		if look.Port > 0 || !strings.Contains(strings.ToLower(err.Error()), "port") {
			return nil, err
		}
	}
	return nil, fmt.Errorf("не нашёл свободный порт: %w", lastErr)
}

// retuneInbound applies a new look to an existing inbound; keys and clients stay.
func (s *Service) retuneInbound(id int, look InboundLook, remark string) error {
	if !inboundExists(id) {
		return nil
	}
	ib, err := s.inboundSvc.GetInbound(id)
	if err != nil {
		return err
	}
	look = look.normalized()
	old := map[string]any{}
	_ = json.Unmarshal([]byte(ib.StreamSettings), &old)
	stream, err := streamFor(look, old)
	if err != nil {
		return err
	}
	ib.StreamSettings = stream
	ib.DisableFlow = look.Transport != "tcp"
	if look.Port > 0 {
		ib.Port = look.Port
	}
	if remark != "" {
		ib.Remark = remark
	}
	_, needRestart, err := s.inboundSvc.UpdateInbound(ib)
	if needRestart {
		s.xraySvc.SetToNeedRestart()
	}
	return err
}

func (s *Service) deleteInbound(id int) {
	if !inboundExists(id) {
		return
	}
	needRestart, err := s.inboundSvc.DelInbound(id)
	if needRestart {
		s.xraySvc.SetToNeedRestart()
	}
	if err != nil {
		logger.Warning("korova: delete inbound", id, err)
	}
}

func inboundExists(id int) bool {
	if id <= 0 {
		return false
	}
	var n int64
	database.GetDB().Model(&model.Inbound{}).Where("id = ?", id).Count(&n)
	return n > 0
}

func inboundPort(id int) int {
	var ib model.Inbound
	if id > 0 && database.GetDB().Select("port").First(&ib, id).Error == nil {
		return ib.Port
	}
	return 0
}

// setSubscription adds and removes inbound ids from the subscriber list in one save.
func (s *Service) setSubscription(add, remove []int) error {
	st := LoadSettings()
	drop := map[int]bool{}
	for _, id := range remove {
		drop[id] = true
	}
	seen := map[int]bool{}
	next := []int{}
	for _, id := range append(append([]int{}, st.InboundIDs...), add...) {
		if id <= 0 || drop[id] || seen[id] {
			continue
		}
		seen[id] = true
		next = append(next, id)
	}
	st.InboundIDs = next
	return s.SaveSettings(st)
}

func (s *Service) getServer(id int) (*model.KorovaServer, error) {
	srv := &model.KorovaServer{}
	if err := database.GetDB().First(srv, id).Error; err != nil {
		return nil, errors.New("сервер не найден")
	}
	return srv, nil
}

func lookOf(srv *model.KorovaServer) InboundLook {
	return InboundLook{Transport: srv.Transport, SNI: srv.SNI}.normalized()
}

func displayName(srv *model.KorovaServer) string {
	if f := countryFlag(srv.Country); f != "" {
		return f + " " + srv.Name
	}
	return srv.Name
}

func routedName(srv, via *model.KorovaServer) string {
	return fmt.Sprintf("%s · через %s", displayName(srv), via.Name)
}

func nodeAddress(nodeID int) string {
	if nodeID == 0 {
		host := LoadSettings().SubBase
		if i := strings.Index(host, "://"); i >= 0 {
			host = host[i+3:]
		}
		if i := strings.IndexAny(host, "/:"); i >= 0 {
			host = host[:i]
		}
		return host
	}
	n := &model.Node{}
	if database.GetDB().First(n, nodeID).Error != nil {
		return ""
	}
	if n.PublicAddress != "" {
		return n.PublicAddress
	}
	return n.Address
}

type PublishRequest struct {
	NodeID  int         `json:"nodeId"`
	Name    string      `json:"name"`
	Country string      `json:"country"`
	Look    InboundLook `json:"look"`
}

// PublishServer makes a node a subscriber-facing server: creates its inbound if
// needed and puts it into every subscription.
func (s *Service) PublishServer(req PublishRequest) (*model.KorovaServer, error) {
	serversMu.Lock()
	defer serversMu.Unlock()
	return s.publishLocked(req)
}

func (s *Service) publishLocked(req PublishRequest) (*model.KorovaServer, error) {
	srv := &model.KorovaServer{}
	if database.GetDB().Where("node_id = ?", req.NodeID).First(srv).Error != nil {
		srv = &model.KorovaServer{NodeID: req.NodeID, InSub: true}
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		srv.Name = name
	}
	if c := strings.ToUpper(strings.TrimSpace(req.Country)); len(c) == 2 {
		srv.Country = c
	}
	if srv.Country == "" || srv.Name == "" {
		code, ruName := detectCountry(nodeAddress(req.NodeID))
		if srv.Country == "" {
			srv.Country = code
		}
		if srv.Name == "" {
			srv.Name = ruName
		}
	}
	if srv.Name == "" {
		srv.Name = defaultServerName(req.NodeID)
	}
	look := req.Look.normalized()
	if srv.Transport == "" || req.Look.Transport != "" {
		srv.Transport = look.Transport
	}
	if srv.SNI == "" || req.Look.SNI != "" {
		srv.SNI = look.SNI
	}
	if !inboundExists(srv.InboundID) {
		ib, err := s.createRealityInbound(req.NodeID, displayName(srv), InboundLook{Transport: srv.Transport, SNI: srv.SNI, Port: req.Look.Port})
		if err != nil {
			return nil, fmt.Errorf("не удалось создать подключение на сервере: %w", err)
		}
		srv.InboundID = ib.Id
	}
	srv.InSub = true
	if err := database.GetDB().Save(srv).Error; err != nil {
		return nil, err
	}
	return srv, s.applyServerSubscription(srv)
}

func defaultServerName(nodeID int) string {
	if nodeID == 0 {
		return "Основной сервер"
	}
	n := &model.Node{}
	if database.GetDB().First(n, nodeID).Error == nil {
		return n.Name
	}
	return fmt.Sprintf("Сервер %d", nodeID)
}

// applyServerSubscription puts exactly the right inbounds of srv into subscriptions.
func (s *Service) applyServerSubscription(srv *model.KorovaServer) error {
	var add, remove []int
	routed := srv.ViaServerID > 0 && inboundExists(srv.EntryInboundID)
	switch {
	case !srv.InSub:
		remove = []int{srv.InboundID, srv.EntryInboundID}
	case routed && srv.KeepDirect:
		add = []int{srv.InboundID, srv.EntryInboundID}
	case routed:
		add = []int{srv.EntryInboundID}
		remove = []int{srv.InboundID}
	default:
		add = []int{srv.InboundID}
		remove = []int{srv.EntryInboundID}
	}
	return s.setSubscription(add, remove)
}

type ServerPatch struct {
	Name        *string `json:"name"`
	Country     *string `json:"country"`
	Transport   *string `json:"transport"`
	SNI         *string `json:"sni"`
	Port        *int    `json:"port"`
	InSub       *bool   `json:"inSub"`
	ViaServerID *int    `json:"viaServerId"`
	KeepDirect  *bool   `json:"keepDirect"`
}

// UpdateServer changes name, look, visibility or route; a route change rebuilds the cascade.
func (s *Service) UpdateServer(id int, p ServerPatch) (*model.KorovaServer, error) {
	serversMu.Lock()
	defer serversMu.Unlock()
	srv, err := s.getServer(id)
	if err != nil {
		return nil, err
	}
	relabel, retune := false, false
	if p.Name != nil && strings.TrimSpace(*p.Name) != "" && strings.TrimSpace(*p.Name) != srv.Name {
		srv.Name, relabel = strings.TrimSpace(*p.Name), true
	}
	if p.Country != nil && strings.ToUpper(*p.Country) != srv.Country {
		srv.Country, relabel = strings.ToUpper(strings.TrimSpace(*p.Country)), true
	}
	if p.Transport != nil && *p.Transport != srv.Transport {
		srv.Transport, retune = InboundLook{Transport: *p.Transport}.normalized().Transport, true
	}
	if p.SNI != nil && *p.SNI != srv.SNI {
		srv.SNI, retune = InboundLook{SNI: *p.SNI}.normalized().SNI, true
	}
	port := 0
	if p.Port != nil && *p.Port > 0 && *p.Port != inboundPort(srv.InboundID) {
		port, retune = *p.Port, true
	}
	if retune || relabel {
		look := lookOf(srv)
		look.Port = port
		if err := s.retuneInbound(srv.InboundID, look, displayName(srv)); err != nil {
			return srv, fmt.Errorf("не удалось применить настройки: %w", err)
		}
		if err := s.retuneDependants(srv, relabel); err != nil {
			return srv, err
		}
	}
	if p.InSub != nil {
		srv.InSub = *p.InSub
	}
	if p.KeepDirect != nil {
		srv.KeepDirect = *p.KeepDirect
	}
	if p.ViaServerID != nil && *p.ViaServerID != srv.ViaServerID {
		if err := s.routeLocked(srv, *p.ViaServerID); err != nil {
			database.GetDB().Save(srv)
			_ = s.applyServerSubscription(srv)
			return srv, err
		}
	}
	if err := database.GetDB().Save(srv).Error; err != nil {
		return srv, err
	}
	return srv, s.applyServerSubscription(srv)
}

// retuneDependants keeps entry inbounds in step: an entry living on srv uses
// srv's look (srv is the server facing users), and its label follows names.
func (s *Service) retuneDependants(srv *model.KorovaServer, relabel bool) error {
	if srv.ViaServerID > 0 && relabel {
		if via, err := s.getServer(srv.ViaServerID); err == nil {
			s.renameInbound(srv.EntryInboundID, routedName(srv, via))
		}
	}
	var deps []model.KorovaServer
	database.GetDB().Where("via_server_id = ?", srv.Id).Find(&deps)
	for i := range deps {
		if err := s.retuneInbound(deps[i].EntryInboundID, lookOf(srv), routedName(&deps[i], srv)); err != nil {
			return fmt.Errorf("не удалось обновить вход %s: %w", deps[i].Name, err)
		}
	}
	return nil
}

func (s *Service) renameInbound(id int, remark string) {
	if !inboundExists(id) {
		return
	}
	ib, err := s.inboundSvc.GetInbound(id)
	if err != nil {
		return
	}
	ib.Remark = remark
	if _, needRestart, err := s.inboundSvc.UpdateInbound(ib); err != nil {
		logger.Warning("korova: rename inbound", id, err)
	} else if needRestart {
		s.xraySvc.SetToNeedRestart()
	}
}

func (s *Service) unrouteLocked(srv *model.KorovaServer) {
	if srv.CascadeID > 0 {
		if err := s.DeleteCascade(srv.CascadeID); err != nil {
			logger.Warning("korova: remove cascade", srv.CascadeID, err)
		}
	}
	if srv.EntryInboundID > 0 {
		_ = s.setSubscription(nil, []int{srv.EntryInboundID})
	}
	s.deleteInbound(srv.EntryInboundID)
	srv.ViaServerID, srv.EntryInboundID, srv.CascadeID = 0, 0, 0
}

// routeLocked sends srv's traffic through the via server: users connect to via,
// Russian sites leave from via directly, everything else goes on to srv.
func (s *Service) routeLocked(srv *model.KorovaServer, viaID int) error {
	s.unrouteLocked(srv)
	if viaID == 0 {
		return nil
	}
	if viaID == srv.Id {
		return errors.New("сервер не может идти сам через себя")
	}
	via, err := s.getServer(viaID)
	if err != nil {
		return errors.New("сервер-вход не найден")
	}
	if via.NodeID == srv.NodeID {
		return errors.New("вход и выход должны быть разными серверами")
	}
	if via.ViaServerID > 0 {
		return fmt.Errorf("%s сам идёт через другой сервер — выбери вход, который работает напрямую", via.Name)
	}
	if !inboundExists(srv.InboundID) {
		return errors.New("у сервера нет подключения — сначала добавь его в подписку")
	}
	entry, err := s.createRealityInbound(via.NodeID, routedName(srv, via), lookOf(via))
	if err != nil {
		return fmt.Errorf("не удалось создать вход на %s: %w", via.Name, err)
	}
	c, err := s.CreateCascade(CascadeRequest{
		Name:           routedName(srv, via),
		EntryInboundID: entry.Id,
		ExitInboundID:  srv.InboundID,
		DirectRu:       true,
	})
	if err != nil {
		if c != nil {
			_ = s.DeleteCascade(c.Id)
		}
		s.deleteInbound(entry.Id)
		return err
	}
	srv.ViaServerID, srv.EntryInboundID, srv.CascadeID = via.Id, entry.Id, c.Id
	return nil
}

// RemoveServer takes a server out of Korova: routes, its inbound and subscription
// entries go; the node itself stays in «Узлы».
func (s *Service) RemoveServer(id int) error {
	serversMu.Lock()
	defer serversMu.Unlock()
	srv, err := s.getServer(id)
	if err != nil {
		return err
	}
	var deps []model.KorovaServer
	database.GetDB().Where("via_server_id = ?", srv.Id).Find(&deps)
	for i := range deps {
		s.unrouteLocked(&deps[i])
		database.GetDB().Save(&deps[i])
		_ = s.applyServerSubscription(&deps[i])
	}
	s.unrouteLocked(srv)
	_ = s.setSubscription(nil, []int{srv.InboundID})
	s.deleteInbound(srv.InboundID)
	return database.GetDB().Delete(srv).Error
}

type ServerRow struct {
	model.KorovaServer
	Configured bool   `json:"configured"`
	Flag       string `json:"flag"`
	Address    string `json:"address"`
	Status     string `json:"status"`
	LatencyMs  int    `json:"latencyMs"`
	Tunnel     bool   `json:"tunnel"`
	Port       int    `json:"port"`
	EntryPort  int    `json:"entryPort"`
	ViaName    string `json:"viaName"`
	CascadeErr string `json:"cascadeError"`
}

// Servers lists every node plus the main server, configured or not, so the
// admin sees one place for "my VPN servers".
func (s *Service) Servers() ([]ServerRow, error) {
	db := database.GetDB()
	var servers []model.KorovaServer
	db.Order("id asc").Find(&servers)
	byNode := map[int]model.KorovaServer{}
	names := map[int]string{}
	for _, srv := range servers {
		byNode[srv.NodeID] = srv
		names[srv.Id] = srv.Name
	}
	var nodes []model.Node
	db.Order("id asc").Find(&nodes)

	row := func(nodeID int, addr, status string, latency int, tunnel bool, fallbackName string) ServerRow {
		r := ServerRow{Address: addr, Status: status, LatencyMs: latency, Tunnel: tunnel}
		if srv, ok := byNode[nodeID]; ok {
			r.KorovaServer = srv
			r.Configured = true
			r.Flag = countryFlag(srv.Country)
			r.Port = inboundPort(srv.InboundID)
			r.EntryPort = inboundPort(srv.EntryInboundID)
			r.ViaName = names[srv.ViaServerID]
			if srv.CascadeID > 0 {
				var c model.KorovaCascade
				if db.First(&c, srv.CascadeID).Error == nil && c.Status != "active" {
					r.CascadeErr = c.LastError
				}
			}
		} else {
			r.NodeID = nodeID
			r.Name = fallbackName
		}
		return r
	}

	out := []ServerRow{}
	for _, n := range nodes {
		addr := n.Address
		if n.PublicAddress != "" {
			addr = n.PublicAddress
		}
		out = append(out, row(n.Id, addr, n.Status, n.LatencyMs, n.PublicAddress != "", n.Name))
	}
	out = append(out, row(0, nodeAddress(0), "online", 0, false, "Основной сервер"))
	return out, nil
}
