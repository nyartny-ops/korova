package korova

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service/panel"
)

const autoBalancerRemark = "⚡ Автовыбор"

// lookMu keeps the bot start and a settings save from both restarting the panel.
var lookMu sync.Mutex

// countryFlag turns "DE" into the regional-indicator pair Happ and Incy render as a flag.
func countryFlag(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		return ""
	}
	return string([]rune{rune(code[0]) - 'A' + 0x1F1E6, rune(code[1]) - 'A' + 0x1F1E6})
}

// detectCountry asks a public geo-IP service; failures just mean "no flag".
func detectCountry(host string) (code, nameRu string) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", ""
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	u := "http://ip-api.com/json/" + url.PathEscape(host) + "?fields=status,countryCode,country&lang=ru"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()
	var out struct {
		Status      string `json:"status"`
		CountryCode string `json:"countryCode"`
		Country     string `json:"country"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil || out.Status != "success" {
		return "", ""
	}
	return strings.ToUpper(out.CountryCode), out.Country
}

// desiredSubLook is what Happ and Incy show around the server list.
func desiredSubLook(st Settings, bot string) map[string]string {
	want := map[string]string{
		"subInfoNodeEnable": "true",
		"subTitle":          st.BrandName,
	}
	if bot != "" {
		link := "https://t.me/" + bot
		support := st.SupportURL
		if support == "" {
			support = link
		}
		want["subSupportUrl"] = support
		want["subProfileUrl"] = link
		want["subAnnounce"] = "Продлить подписку или добавить устройство — в боте @" + bot
		want["subExpiredTemplate"] = "⛔ Подписка закончилась · продли в @" + bot
		want["subTrafficDepletedTemplate"] = "⛔ Трафик закончился · продли в @" + bot
	}
	if st.AutoSelect {
		want["subJsonEnable"] = "true"
		want["subJsonAutoDetect"] = "true"
		want["subJsonUserAgentRegex"] = "(?i)(happ|incy)"
	} else {
		want["subJsonAutoDetect"] = "false"
	}
	return want
}

// ApplySubscriptionLook writes subscription metadata and the auto-select balancer,
// restarting the subscription server only when something actually changed.
func (s *Service) ApplySubscriptionLook() {
	lookMu.Lock()
	defer lookMu.Unlock()
	st := LoadSettings()
	s.syncAutoBalancer(st)
	if !st.ManageSubLook {
		return
	}
	_, bot, _ := BotStatus()
	changed := false
	for k, v := range desiredSubLook(st, bot) {
		cur, err := s.settingSvc.GetValue(k)
		if err != nil || cur == v {
			continue
		}
		if err := s.settingSvc.SetValue(k, v); err != nil {
			logger.Warning("korova: sub look", k, err)
			continue
		}
		changed = true
	}
	if changed {
		var ps panel.PanelService
		_ = ps.RestartPanel(3 * time.Second)
	}
}

// syncAutoBalancer keeps one client-side balancer over every subscriber server:
// Happ/Incy then show «⚡ Автовыбор», which picks the fastest one by ping.
func (s *Service) syncAutoBalancer(st Settings) {
	var bs service.SubBalancerService
	var existing model.SubBalancer
	found := database.GetDB().Where("remark = ?", autoBalancerRemark).First(&existing).Error == nil
	ids := s.validInboundIDs(st.InboundIDs)
	if !st.AutoSelect || len(ids) < 2 {
		if found && existing.Enabled {
			database.GetDB().Model(&model.SubBalancer{}).Where("id = ?", existing.Id).Update("enabled", false)
		}
		return
	}
	b := &model.SubBalancer{Remark: autoBalancerRemark, Strategy: "leastPing", InboundIds: ids, SortOrder: 1, Enabled: true}
	if !found {
		if _, err := bs.Create(b); err != nil {
			logger.Warning("korova: create auto balancer:", err)
		}
		return
	}
	on := true
	if _, err := bs.Update(existing.Id, b, &on); err != nil {
		logger.Warning("korova: update auto balancer:", err)
	}
}
