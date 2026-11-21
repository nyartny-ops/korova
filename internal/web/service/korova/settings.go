// Package korova is the subscriber layer of Korova VPN: Telegram users, plans,
// promo codes, Stars payments and cascades on top of the 3x-ui core.
package korova

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
)

// Settings is the whole Korova configuration as edited on the "Бот и доступ" page.
type Settings struct {
	BrandName      string  `json:"brandName"`
	Mode           string  `json:"mode"`
	BotToken       string  `json:"botToken"`
	BotEnabled     bool    `json:"botEnabled"`
	AdminUsernames string  `json:"adminUsernames"`
	AdminIDs       []int64 `json:"adminIds"`
	SupportURL     string  `json:"supportUrl"`
	SubBase        string  `json:"subBase"`
	InboundIDs     []int   `json:"inboundIds"`
	DeviceMode     string  `json:"deviceMode"`
	TrialDays      int     `json:"trialDays"`
	TrialDevices   int     `json:"trialDevices"`
	RemindDays     []int   `json:"remindDays"`
	WelcomeText    string  `json:"welcomeText"`
	InviteOnlyText string  `json:"inviteOnlyText"`
	ExpiredText    string  `json:"expiredText"`
	HappEnabled    bool    `json:"happEnabled"`
	IncyEnabled    bool    `json:"incyEnabled"`
}

func defaultSettings() Settings {
	return Settings{
		BrandName:      "Korova VPN",
		Mode:           model.KorovaModeInvite,
		AdminUsernames: "TheArtemy",
		DeviceMode:     "hwid",
		TrialDays:      0,
		TrialDevices:   1,
		RemindDays:     []int{3, 1},
		WelcomeText:    "Быстрый VPN без лишних настроек. Нажми «Подключить», и через минуту всё заработает.",
		InviteOnlyText: "Сейчас Korova работает по приглашениям. Введи промокод от администратора или напиши ему.",
		ExpiredText:    "Подписка закончилась. Продли её в боте, и серверы вернутся автоматически.",
		HappEnabled:    true,
		IncyEnabled:    true,
	}
}

const settingsKey = "settings"

var settingsMu sync.RWMutex

func LoadSettings() Settings {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	s := defaultSettings()
	var row model.KorovaSetting
	if err := database.GetDB().Where("key = ?", settingsKey).First(&row).Error; err != nil {
		return s.withLists()
	}
	_ = json.Unmarshal([]byte(row.Value), &s)
	if s.Mode != model.KorovaModePaid {
		s.Mode = model.KorovaModeInvite
	}
	if s.DeviceMode != "ip" && s.DeviceMode != "both" {
		s.DeviceMode = "hwid"
	}
	return s.withLists()
}

// withLists turns nil slices into empty ones: JSON null crashes the settings screen.
func (s Settings) withLists() Settings {
	if s.InboundIDs == nil {
		s.InboundIDs = []int{}
	}
	if s.AdminIDs == nil {
		s.AdminIDs = []int64{}
	}
	if s.RemindDays == nil {
		s.RemindDays = []int{}
	}
	return s
}

func saveSettings(s Settings) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return database.GetDB().Save(&model.KorovaSetting{Key: settingsKey, Value: string(raw)}).Error
}

func (s Settings) IsAdmin(id int64, username string) bool {
	for _, a := range s.AdminIDs {
		if a == id {
			return true
		}
	}
	u := strings.ToLower(strings.TrimPrefix(username, "@"))
	if u == "" {
		return false
	}
	for _, name := range strings.Split(s.AdminUsernames, ",") {
		if strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@")) == u {
			return true
		}
	}
	return false
}

// SupportLink falls back to the first admin username so users always have someone to write to.
func (s Settings) SupportLink() string {
	if s.SupportURL != "" {
		return s.SupportURL
	}
	for _, name := range strings.Split(s.AdminUsernames, ",") {
		name = strings.TrimPrefix(strings.TrimSpace(name), "@")
		if name != "" {
			return "https://t.me/" + name
		}
	}
	return ""
}

func (s Settings) limits(devices int) (limitIP, limitHwid int) {
	switch s.DeviceMode {
	case "ip":
		return devices, 0
	case "both":
		return devices, devices
	default:
		return 0, devices
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
