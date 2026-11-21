package korova

import (
	"os"
	"strings"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
)

const seededKey = "seeded-v1"

// Bootstrap runs once per process start: first-run defaults, env overrides, bot.
func Bootstrap(svc *Service) {
	var row model.KorovaSetting
	if database.GetDB().Where("key = ?", seededKey).First(&row).Error != nil {
		seedFirstRun(svc)
		database.GetDB().Save(&model.KorovaSetting{Key: seededKey, Value: "1"})
	}
	applyEnv(svc)
	RestartBot(svc)
	svc.ApplySubscriptionLook()
}

func seedFirstRun(svc *Service) {
	svc.SeedPlans()
	defaults := map[string]string{
		"subInfoNodeEnable":          "true",
		"subExpiredTemplate":         "Подписка истекла · продлите в боте",
		"subTrafficDepletedTemplate": "Трафик закончился · продлите в боте",
		"remarkTemplate":             "{{INBOUND}}",
		"subTitle":                   "Korova VPN",
	}
	for k, v := range defaults {
		if err := svc.settingSvc.SetValue(k, v); err != nil {
			logger.Warning("korova seed", k, err)
		}
	}
}

// applyEnv lets install.sh hand over the bot token and domains without the UI.
func applyEnv(svc *Service) {
	st := LoadSettings()
	changed := false
	if t := strings.TrimSpace(os.Getenv("KOROVA_BOT_TOKEN")); t != "" && st.BotToken == "" {
		st.BotToken, st.BotEnabled, changed = t, true, true
	}
	if a := strings.TrimSpace(os.Getenv("KOROVA_ADMINS")); a != "" && st.AdminUsernames == defaultSettings().AdminUsernames {
		st.AdminUsernames, changed = a, true
	}
	if d := strings.TrimSpace(os.Getenv("KOROVA_SUB_DOMAIN")); d != "" && st.SubBase == "" {
		path, _ := svc.settingSvc.GetSubPath()
		if path == "" {
			path = "/sub/"
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		if !strings.HasSuffix(path, "/") {
			path += "/"
		}
		st.SubBase, changed = "https://"+d+path, true
		if err := svc.settingSvc.SetValue("subURI", st.SubBase); err != nil {
			logger.Warning("korova subURI:", err)
		}
	}
	if changed {
		if err := saveSettings(st); err != nil {
			logger.Warning("korova env settings:", err)
		}
	}
}
