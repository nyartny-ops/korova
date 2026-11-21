package korova

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/util/link"
	"github.com/mhsanaei/3x-ui/v3/internal/web/runtime"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
)

// CascadeRequest chains an entry inbound (usually a RU server users connect to)
// through an exit inbound abroad: entry -> exit -> internet.
type CascadeRequest struct {
	Name           string `json:"name"`
	EntryInboundID int    `json:"entryInboundId"`
	ExitInboundID  int    `json:"exitInboundId"`
	ExitAddress    string `json:"exitAddress"`
	DirectRu       bool   `json:"directRu"`
}

var tagSafe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func (s *Service) Cascades() ([]model.KorovaCascade, error) {
	var out []model.KorovaCascade
	err := database.GetDB().Order("id desc").Find(&out).Error
	return out, err
}

func nodeOf(ib *model.Inbound) int {
	if ib.NodeID == nil {
		return 0
	}
	return *ib.NodeID
}

func localTag(ib *model.Inbound) string {
	if ib.NodeID == nil {
		return ib.Tag
	}
	return strings.TrimPrefix(ib.Tag, fmt.Sprintf("n%d-", *ib.NodeID))
}

func (s *Service) CreateCascade(req CascadeRequest) (*model.KorovaCascade, error) {
	entry, err := s.inboundSvc.GetInbound(req.EntryInboundID)
	if err != nil {
		return nil, errors.New("входной inbound не найден")
	}
	exit, err := s.inboundSvc.GetInbound(req.ExitInboundID)
	if err != nil {
		return nil, errors.New("выходной inbound не найден")
	}
	if nodeOf(entry) == nodeOf(exit) {
		return nil, errors.New("вход и выход должны быть на разных серверах")
	}
	switch exit.Protocol {
	case model.VLESS, model.VMESS, model.Trojan, model.Shadowsocks:
	default:
		return nil, errors.New("для выхода нужен inbound VLESS, VMess, Trojan или Shadowsocks")
	}

	address := strings.TrimSpace(req.ExitAddress)
	if address == "" && exit.NodeID != nil {
		node := &model.Node{}
		if err := database.GetDB().First(node, *exit.NodeID).Error; err == nil {
			address = node.Address
			if node.PublicAddress != "" {
				address = node.PublicAddress
			}
		}
	}
	if address == "" {
		// The main server: its public name is the subscription domain.
		address = nodeAddress(nodeOf(exit))
	}
	if address == "" {
		return nil, errors.New("не знаю публичный адрес выходного сервера: укажи домен подписки в «Бот и доступ»")
	}

	c := &model.KorovaCascade{
		Name: strings.TrimSpace(req.Name), EntryNodeID: nodeOf(entry), EntryInboundID: entry.Id,
		EntryTag: localTag(entry), ExitNodeID: nodeOf(exit), ExitInboundID: exit.Id,
		DirectRu: req.DirectRu, Status: "pending",
	}
	if c.Name == "" {
		c.Name = fmt.Sprintf("%s → %s", entry.Remark, exit.Remark)
	}
	if err := database.GetDB().Create(c).Error; err != nil {
		return nil, err
	}
	c.OutboundTag = fmt.Sprintf("korova-cascade-%d", c.Id)
	c.ClientEmail = "cascade-" + tagSafe.ReplaceAllString(c.EntryTag, "-") + "-" + itoa(c.Id)

	fail := func(e error) (*model.KorovaCascade, error) {
		c.Status, c.LastError = "error", e.Error()
		database.GetDB().Save(c)
		return c, e
	}

	needRestart, err := s.clientSvc.Create(&s.inboundSvc, &service.ClientCreatePayload{
		Client: model.Client{
			ID: uuid.NewString(), Email: c.ClientEmail, Enable: true,
			Comment: "Korova cascade: " + c.Name, Group: "korova-cascade",
		},
		InboundIds: []int{exit.Id},
	})
	if needRestart {
		s.xraySvc.SetToNeedRestart()
	}
	if err != nil {
		return fail(fmt.Errorf("не удалось создать клиента на выходе: %w", err))
	}

	links, err := s.inboundSvc.GetAllClientLinks(address, c.ClientEmail)
	if err != nil || len(links) == 0 {
		return fail(fmt.Errorf("не удалось получить ссылку выхода: %v", err))
	}
	parsed, err := link.ParseLink(links[0])
	if err != nil {
		return fail(fmt.Errorf("ссылка выхода не разобралась: %w", err))
	}
	outbound := map[string]any(parsed.Outbound)
	outbound["tag"] = c.OutboundTag

	if err := s.editEntryTemplate(c, func(cfg map[string]any) {
		applyCascade(cfg, c, outbound)
	}); err != nil {
		return fail(err)
	}
	c.Status, c.LastError = "active", ""
	return c, database.GetDB().Save(c).Error
}

func (s *Service) DeleteCascade(id int) error {
	c := &model.KorovaCascade{}
	if err := database.GetDB().First(c, id).Error; err != nil {
		return err
	}
	if c.OutboundTag != "" {
		if err := s.editEntryTemplate(c, func(cfg map[string]any) { removeCascade(cfg, c) }); err != nil {
			return fmt.Errorf("не удалось убрать каскад со входного сервера: %w", err)
		}
	}
	if c.ClientEmail != "" {
		if rec, err := s.clientSvc.GetRecordByEmail(nil, c.ClientEmail); err == nil {
			needRestart, _ := s.clientSvc.Delete(&s.inboundSvc, rec.Id, false)
			if needRestart {
				s.xraySvc.SetToNeedRestart()
			}
		}
	}
	return database.GetDB().Delete(c).Error
}

// editEntryTemplate loads the entry server's Xray template (local DB or the
// node's API), lets mutate change it, and saves + applies it there.
func (s *Service) editEntryTemplate(c *model.KorovaCascade, mutate func(map[string]any)) error {
	if c.EntryNodeID == 0 {
		raw, err := s.settingSvc.GetXrayConfigTemplate()
		if err != nil {
			return err
		}
		cfg := map[string]any{}
		if err := json.Unmarshal([]byte(service.UnwrapXrayTemplateConfig(raw)), &cfg); err != nil {
			return fmt.Errorf("шаблон Xray повреждён: %w", err)
		}
		mutate(cfg)
		next, _ := json.MarshalIndent(cfg, "", "  ")
		var xs service.XraySettingService
		if err := xs.SaveXraySetting(string(next)); err != nil {
			return err
		}
		if s.xraySvc.IsXrayRunning() {
			return s.xraySvc.RestartXray(false)
		}
		return nil
	}

	node := &model.Node{}
	if err := database.GetDB().First(node, c.EntryNodeID).Error; err != nil {
		return errors.New("входная нода не найдена")
	}
	mgr := runtime.GetManager()
	if mgr == nil {
		return errors.New("менеджер нод ещё не запущен")
	}
	remote, err := mgr.RemoteFor(node)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	obj, err := remote.Call(ctx, http.MethodPost, "panel/api/xray/", nil)
	if err != nil {
		return fmt.Errorf("нода не отдала настройки Xray (нужен токен с правами node-admin): %w", err)
	}
	var wrapped string
	if err := json.Unmarshal(obj, &wrapped); err != nil {
		wrapped = string(obj)
	}
	var resp struct {
		XraySetting     json.RawMessage `json:"xraySetting"`
		OutboundTestUrl string          `json:"outboundTestUrl"`
	}
	if err := json.Unmarshal([]byte(wrapped), &resp); err != nil {
		return fmt.Errorf("ответ ноды не разобрался: %w", err)
	}
	cfg := map[string]any{}
	if err := json.Unmarshal(resp.XraySetting, &cfg); err != nil {
		return fmt.Errorf("шаблон Xray ноды повреждён: %w", err)
	}
	mutate(cfg)
	next, _ := json.Marshal(cfg)
	form := url.Values{}
	form.Set("xraySetting", string(next))
	form.Set("outboundTestUrl", resp.OutboundTestUrl)
	if _, err := remote.Call(ctx, http.MethodPost, "panel/api/xray/update", form); err != nil {
		return fmt.Errorf("нода не приняла новые настройки: %w", err)
	}
	// The node saves the template but runs the old config until Xray restarts.
	s.restartNodeXrayLater(node.Id)
	return nil
}

func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func removeCascade(cfg map[string]any, c *model.KorovaCascade) {
	var obs []any
	for _, o := range asSlice(cfg["outbounds"]) {
		if m := asMap(o); m != nil && m["tag"] == c.OutboundTag {
			continue
		}
		obs = append(obs, o)
	}
	cfg["outbounds"] = obs
	routing := asMap(cfg["routing"])
	if routing == nil {
		return
	}
	var rules []any
	for _, r := range asSlice(routing["rules"]) {
		if m := asMap(r); m != nil {
			if tag, _ := m["ruleTag"].(string); strings.HasPrefix(tag, c.OutboundTag) {
				continue
			}
		}
		rules = append(rules, r)
	}
	routing["rules"] = rules
}

func directTag(cfg map[string]any) string {
	for _, o := range asSlice(cfg["outbounds"]) {
		if m := asMap(o); m != nil && m["protocol"] == "freedom" {
			if t, _ := m["tag"].(string); t != "" {
				return t
			}
		}
	}
	cfg["outbounds"] = append(asSlice(cfg["outbounds"]), map[string]any{"tag": "direct", "protocol": "freedom", "settings": map[string]any{}})
	return "direct"
}

// applyCascade appends the exit outbound (never first, so it does not become the
// default route) and puts the cascade rules at the top of routing.
func applyCascade(cfg map[string]any, c *model.KorovaCascade, outbound map[string]any) {
	removeCascade(cfg, c)
	cfg["outbounds"] = append(asSlice(cfg["outbounds"]), outbound)
	routing := asMap(cfg["routing"])
	if routing == nil {
		routing = map[string]any{"domainStrategy": "AsIs"}
		cfg["routing"] = routing
	}
	var head []any
	if c.DirectRu {
		direct := directTag(cfg)
		head = append(head,
			map[string]any{
				"type": "field", "ruleTag": c.OutboundTag + "-ru-domains", "inboundTag": []any{c.EntryTag},
				"domain":      []any{"regexp:.*\\.ru$", "regexp:.*\\.su$", "regexp:.*\\.xn--p1ai$"},
				"outboundTag": direct,
			},
			map[string]any{
				"type": "field", "ruleTag": c.OutboundTag + "-ru-ip", "inboundTag": []any{c.EntryTag},
				"ip": []any{"geoip:ru"}, "outboundTag": direct,
			},
		)
	}
	head = append(head, map[string]any{
		"type": "field", "ruleTag": c.OutboundTag + "-main", "inboundTag": []any{c.EntryTag},
		"outboundTag": c.OutboundTag,
	})
	routing["rules"] = append(head, asSlice(routing["rules"])...)
}
