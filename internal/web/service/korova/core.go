package korova

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
	"github.com/mhsanaei/3x-ui/v3/internal/util/random"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service"
	"github.com/mhsanaei/3x-ui/v3/internal/xray"
)

const dayMs = int64(24 * time.Hour / time.Millisecond)

var (
	ErrNoServers     = errors.New("в настройках Korova не выбраны серверы для подписчиков")
	ErrPromoNotFound = errors.New("промокод не найден")
	ErrPromoUsed     = errors.New("этот промокод уже использован")
	ErrPromoExpired  = errors.New("срок действия промокода истёк")
	ErrPromoPaidMode = errors.New("бесплатные приглашения сейчас отключены: включён режим подписки")
	ErrPlanNotFound  = errors.New("тариф не найден")
	ErrBanned        = errors.New("доступ заблокирован администратором")
)

// Service is stateless apart from one lock that serialises subscription changes,
// so a double-tapped payment or promo cannot apply twice.
type Service struct {
	clientSvc  service.ClientService
	inboundSvc service.InboundService
	xraySvc    service.XrayService
	settingSvc service.SettingService
}

var mutateMu sync.Mutex

func nowMs() int64 { return time.Now().UnixMilli() }

func (s *Service) Settings() Settings { return LoadSettings() }

func (s *Service) SaveSettings(next Settings) error {
	prev := LoadSettings()
	if next.Mode != model.KorovaModePaid {
		next.Mode = model.KorovaModeInvite
	}
	if err := saveSettings(next); err != nil {
		return err
	}
	if prev.Mode != next.Mode && next.Mode == model.KorovaModePaid {
		go s.closeFreeAccess()
	}
	if !sameInts(prev.InboundIDs, next.InboundIDs) || prev.DeviceMode != next.DeviceMode {
		go func() {
			if _, err := s.SyncAll(); err != nil {
				logger.Warning("korova: sync after settings change:", err)
			}
		}()
	}
	return nil
}

// ---------- subscribers ----------

func (s *Service) GetUser(tgID int64) (*model.KorovaUser, error) {
	u := &model.KorovaUser{}
	err := database.GetDB().Where("tg_id = ?", tgID).First(u).Error
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (s *Service) GetUserByID(id int) (*model.KorovaUser, error) {
	u := &model.KorovaUser{}
	if err := database.GetDB().First(u, id).Error; err != nil {
		return nil, err
	}
	return u, nil
}

// Touch registers a Telegram user on first contact and refreshes their name.
func (s *Service) Touch(tgID int64, username, firstName string) (*model.KorovaUser, bool, error) {
	db := database.GetDB()
	u, err := s.GetUser(tgID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		u = &model.KorovaUser{
			TgID: tgID, Username: username, FirstName: firstName,
			Access: model.KorovaAccessNone, LastSeenAt: nowMs(),
		}
		if cErr := db.Create(u).Error; cErr != nil {
			return nil, false, cErr
		}
		return u, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	u.Username, u.FirstName, u.LastSeenAt = username, firstName, nowMs()
	err = db.Model(u).Updates(map[string]any{"username": username, "first_name": firstName, "last_seen_at": u.LastSeenAt}).Error
	return u, false, err
}

// HasAccess is the single definition of "this subscriber may connect right now".
func HasAccess(u *model.KorovaUser) bool {
	if u == nil || u.Banned {
		return false
	}
	switch u.Access {
	case model.KorovaAccessFree:
		return true
	case model.KorovaAccessPaid:
		return u.ExpiresAt > nowMs()
	}
	return false
}

func (s *Service) SubURL(u *model.KorovaUser) string {
	if u == nil || u.SubID == "" {
		return ""
	}
	base := LoadSettings().SubBase
	if base == "" {
		base, _ = s.settingSvc.GetSubURI()
	}
	if base == "" {
		return ""
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return base + u.SubID
}

func clientEmailFor(tgID int64) string { return fmt.Sprintf("tg%d", tgID) }

// applyClient makes the panel client mirror the subscriber: one identity, every
// configured inbound, the device limit and the expiry. Callers hold mutateMu.
func (s *Service) applyClient(u *model.KorovaUser) error {
	st := LoadSettings()
	inboundIDs := s.validInboundIDs(st.InboundIDs)
	enabled := HasAccess(u)
	expiry := u.ExpiresAt
	if u.Access == model.KorovaAccessFree && enabled {
		expiry = 0
	}
	if !enabled && (expiry == 0 || expiry > nowMs()) {
		// A past expiry makes the subscription show the "renew" info entry.
		expiry = nowMs() - 1000
	}
	devices := u.Devices
	if devices <= 0 {
		devices = 1
	}
	limitIP, limitHwid := st.limits(devices)
	comment := strings.TrimSpace("@" + u.Username)
	if u.Username == "" {
		comment = u.FirstName
	}

	if u.ClientEmail == "" {
		u.ClientEmail = clientEmailFor(u.TgID)
	}
	rec, err := s.clientSvc.GetRecordByEmail(nil, u.ClientEmail)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	var needRestart bool
	if rec == nil {
		if len(inboundIDs) == 0 {
			return ErrNoServers
		}
		if u.SubID == "" {
			u.SubID = random.Seq(20)
		}
		payload := &service.ClientCreatePayload{
			Client: model.Client{
				ID:         uuid.NewString(),
				Email:      u.ClientEmail,
				SubID:      u.SubID,
				LimitIP:    limitIP,
				ExpiryTime: expiry,
				Enable:     enabled,
				TgID:       u.TgID,
				Comment:    comment,
				Group:      "korova",
			},
			InboundIds: inboundIDs,
			LimitHwid:  limitHwid,
		}
		needRestart, err = s.clientSvc.Create(&s.inboundSvc, payload)
	} else {
		u.SubID = rec.SubID
		c := rec.ToClient()
		c.LimitIP = limitIP
		c.ExpiryTime = expiry
		c.Enable = enabled
		c.TgID = u.TgID
		c.Comment = comment
		needRestart, err = s.clientSvc.UpdateKeepFlows(&s.inboundSvc, rec.Id, *c, limitHwid)
		if err == nil && len(inboundIDs) > 0 {
			var attachRestart bool
			attachRestart, err = s.clientSvc.Attach(&s.inboundSvc, rec.Id, inboundIDs)
			needRestart = needRestart || attachRestart
		}
	}
	if needRestart {
		s.xraySvc.SetToNeedRestart()
	}
	saveErr := database.GetDB().Model(&model.KorovaUser{}).Where("id = ?", u.Id).
		Updates(map[string]any{"client_email": u.ClientEmail, "sub_id": u.SubID}).Error
	if err != nil {
		return err
	}
	return saveErr
}

func (s *Service) validInboundIDs(ids []int) []int {
	if len(ids) == 0 {
		return nil
	}
	var existing []int
	database.GetDB().Model(&model.Inbound{}).Where("id IN ?", ids).Pluck("id", &existing)
	sort.Ints(existing)
	return existing
}

func (s *Service) persist(u *model.KorovaUser) error {
	return database.GetDB().Save(u).Error
}

// extend adds days on top of the remaining time, or from now when expired.
func extend(u *model.KorovaUser, days int) {
	base := u.ExpiresAt
	if base < nowMs() {
		base = nowMs()
	}
	u.ExpiresAt = base + int64(days)*dayMs
	u.Access = model.KorovaAccessPaid
	u.RemindedAt = 0
}

// ---------- plans & payments ----------

func (s *Service) Plans(activeOnly bool) ([]model.KorovaPlan, error) {
	var plans []model.KorovaPlan
	q := database.GetDB().Order("sort asc, devices asc, days asc")
	if activeOnly {
		q = q.Where("active = ?", true)
	}
	err := q.Find(&plans).Error
	return plans, err
}

func (s *Service) SavePlan(p *model.KorovaPlan) error {
	if p.Devices < 1 || p.Days < 1 || p.PriceStars < 1 {
		return errors.New("у тарифа должны быть устройства, срок и цена больше нуля")
	}
	if strings.TrimSpace(p.Title) == "" {
		p.Title = fmt.Sprintf("%d устр. · %d дн.", p.Devices, p.Days)
	}
	return database.GetDB().Save(p).Error
}

func (s *Service) DeletePlan(id int) error {
	return database.GetDB().Delete(&model.KorovaPlan{}, id).Error
}

func (s *Service) GetPlan(id int) (*model.KorovaPlan, error) {
	p := &model.KorovaPlan{}
	if err := database.GetDB().First(p, id).Error; err != nil {
		return nil, ErrPlanNotFound
	}
	return p, nil
}

// SeedPlans fills a fresh install with device-based tariffs the admin can edit.
func (s *Service) SeedPlans() {
	var n int64
	database.GetDB().Model(&model.KorovaPlan{}).Count(&n)
	if n > 0 {
		return
	}
	seed := []model.KorovaPlan{
		{Title: "Соло", Devices: 1, Days: 30, PriceStars: 99, Active: true, Sort: 1},
		{Title: "Дуэт", Devices: 3, Days: 30, PriceStars: 179, Active: true, Featured: true, Sort: 2},
		{Title: "Стадо", Devices: 5, Days: 30, PriceStars: 249, Active: true, Sort: 3},
		{Title: "Дуэт на 3 месяца", Devices: 3, Days: 90, PriceStars: 479, Active: true, Sort: 4},
	}
	for i := range seed {
		database.GetDB().Create(&seed[i])
	}
}

// ApplyPayment is idempotent on the Telegram charge id.
func (s *Service) ApplyPayment(tgID int64, planID int, stars int, chargeID string) (*model.KorovaUser, *model.KorovaPlan, error) {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	var dup int64
	database.GetDB().Model(&model.KorovaPayment{}).Where("charge_id = ?", chargeID).Count(&dup)
	u, err := s.GetUser(tgID)
	if err != nil {
		return nil, nil, err
	}
	plan, err := s.GetPlan(planID)
	if err != nil {
		return u, nil, err
	}
	if dup > 0 {
		return u, plan, nil
	}
	pay := &model.KorovaPayment{
		TgID: tgID, PlanID: plan.Id, PlanTitle: plan.Title, Stars: stars,
		Days: plan.Days, Devices: plan.Devices, ChargeID: chargeID,
	}
	if err := database.GetDB().Create(pay).Error; err != nil {
		return u, plan, err
	}
	if u.Access == model.KorovaAccessFree {
		u.ExpiresAt = 0
	}
	extend(u, plan.Days)
	u.Devices = plan.Devices
	u.PlanID = plan.Id
	u.SpentStars += stars
	if err := s.persist(u); err != nil {
		return u, plan, err
	}
	return u, plan, s.applyClient(u)
}

// StartTrial grants the configured free days once per Telegram account.
func (s *Service) StartTrial(tgID int64) (*model.KorovaUser, error) {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	st := LoadSettings()
	u, err := s.GetUser(tgID)
	if err != nil {
		return nil, err
	}
	if st.TrialDays <= 0 || u.TrialUsed || st.Mode != model.KorovaModePaid {
		return u, errors.New("пробный период недоступен")
	}
	u.TrialUsed = true
	extend(u, st.TrialDays)
	u.Devices = max(st.TrialDevices, 1)
	if err := s.persist(u); err != nil {
		return u, err
	}
	return u, s.applyClient(u)
}

// ---------- promo codes ----------

func normalizeCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

func (s *Service) Promos() ([]model.KorovaPromo, error) {
	var out []model.KorovaPromo
	err := database.GetDB().Order("id desc").Find(&out).Error
	return out, err
}

func (s *Service) SavePromo(p *model.KorovaPromo) error {
	p.Code = normalizeCode(p.Code)
	if p.Code == "" {
		p.Code = "MOO-" + strings.ToUpper(random.Seq(6))
	}
	if p.Kind != model.KorovaPromoFree {
		p.Kind = model.KorovaPromoDays
		if p.Days < 1 {
			return errors.New("укажите, сколько дней даёт промокод")
		}
	}
	if p.Devices < 1 {
		p.Devices = 1
	}
	if p.MaxUses < 1 {
		p.MaxUses = 1
	}
	return database.GetDB().Save(p).Error
}

func (s *Service) DeletePromo(id int) error {
	return database.GetDB().Delete(&model.KorovaPromo{}, id).Error
}

func (s *Service) RedeemPromo(tgID int64, code string) (*model.KorovaUser, *model.KorovaPromo, error) {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	st := LoadSettings()
	u, err := s.GetUser(tgID)
	if err != nil {
		return nil, nil, err
	}
	if u.Banned {
		return u, nil, ErrBanned
	}
	p := &model.KorovaPromo{}
	if err := database.GetDB().Where("code = ? AND active = ?", normalizeCode(code), true).First(p).Error; err != nil {
		return u, nil, ErrPromoNotFound
	}
	if p.ExpiresAt > 0 && p.ExpiresAt < nowMs() {
		return u, p, ErrPromoExpired
	}
	if p.Uses >= p.MaxUses {
		return u, p, ErrPromoUsed
	}
	var used int64
	database.GetDB().Model(&model.KorovaPromoUse{}).Where("promo_id = ? AND tg_id = ?", p.Id, tgID).Count(&used)
	if used > 0 {
		return u, p, ErrPromoUsed
	}
	if p.Kind == model.KorovaPromoFree && st.Mode == model.KorovaModePaid {
		return u, p, ErrPromoPaidMode
	}

	err = database.GetDB().Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.KorovaPromo{}).Where("id = ? AND uses < max_uses", p.Id).
			Update("uses", gorm.Expr("uses + 1"))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrPromoUsed
		}
		return tx.Create(&model.KorovaPromoUse{PromoID: p.Id, TgID: tgID}).Error
	})
	if err != nil {
		return u, p, err
	}

	if p.Kind == model.KorovaPromoFree {
		u.Access = model.KorovaAccessFree
		u.ExpiresAt = 0
	} else {
		extend(u, p.Days)
	}
	if p.Devices > u.Devices {
		u.Devices = p.Devices
	}
	u.InvitedBy = p.Code
	if err := s.persist(u); err != nil {
		return u, p, err
	}
	return u, p, s.applyClient(u)
}

// ---------- admin actions on a subscriber ----------

type AdminAction struct {
	Action  string `json:"action"`
	Days    int    `json:"days"`
	Devices int    `json:"devices"`
	Note    string `json:"note"`
}

func (s *Service) AdminUpdate(id int, a AdminAction) (*model.KorovaUser, error) {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	u, err := s.GetUserByID(id)
	if err != nil {
		return nil, err
	}
	switch a.Action {
	case "extend":
		if a.Days == 0 {
			return u, errors.New("укажите количество дней")
		}
		if u.Access == model.KorovaAccessFree {
			u.ExpiresAt = 0
		}
		extend(u, a.Days)
	case "devices":
		if a.Devices < 1 {
			return u, errors.New("минимум одно устройство")
		}
		u.Devices = a.Devices
	case "free":
		u.Access = model.KorovaAccessFree
		u.ExpiresAt = 0
		if u.Devices < 1 {
			u.Devices = max(a.Devices, 1)
		}
	case "revoke":
		u.Access = model.KorovaAccessNone
		u.ExpiresAt = nowMs() - 1000
	case "ban":
		u.Banned = true
	case "unban":
		u.Banned = false
	case "note":
		u.Note = a.Note
	default:
		return u, errors.New("неизвестное действие")
	}
	if err := s.persist(u); err != nil {
		return u, err
	}
	if a.Action == "note" || (u.ClientEmail == "" && !HasAccess(u)) {
		return u, nil
	}
	return u, s.applyClient(u)
}

func (s *Service) DeleteUser(id int) error {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	u, err := s.GetUserByID(id)
	if err != nil {
		return err
	}
	if u.ClientEmail != "" {
		if rec, rErr := s.clientSvc.GetRecordByEmail(nil, u.ClientEmail); rErr == nil {
			needRestart, dErr := s.clientSvc.Delete(&s.inboundSvc, rec.Id, false)
			if needRestart {
				s.xraySvc.SetToNeedRestart()
			}
			if dErr != nil {
				return dErr
			}
		}
	}
	return database.GetDB().Delete(&model.KorovaUser{}, id).Error
}

// SyncAll re-applies every subscriber, e.g. after a new server was added.
func (s *Service) SyncAll() (int, error) {
	mutateMu.Lock()
	defer mutateMu.Unlock()
	var users []model.KorovaUser
	if err := database.GetDB().Where("client_email <> '' OR access <> ?", model.KorovaAccessNone).Find(&users).Error; err != nil {
		return 0, err
	}
	var errs []string
	n := 0
	for i := range users {
		if err := s.applyClient(&users[i]); err != nil {
			errs = append(errs, fmt.Sprintf("%d: %v", users[i].TgID, err))
			continue
		}
		n++
	}
	if len(errs) > 0 {
		return n, errors.New(strings.Join(errs, "; "))
	}
	return n, nil
}

// closeFreeAccess runs when the admin switches to paid mode: invited accounts
// lose access and are asked to subscribe.
func (s *Service) closeFreeAccess() {
	mutateMu.Lock()
	var users []model.KorovaUser
	database.GetDB().Where("access = ?", model.KorovaAccessFree).Find(&users)
	for i := range users {
		users[i].Access = model.KorovaAccessNone
		users[i].ExpiresAt = nowMs() - 1000
		if err := s.persist(&users[i]); err == nil {
			if aErr := s.applyClient(&users[i]); aErr != nil {
				logger.Warning("korova: close free access", users[i].TgID, aErr)
			}
		}
	}
	mutateMu.Unlock()
	for _, u := range users {
		notify(u.TgID, "Korova перешла на подписку. Бесплатный доступ по приглашению закончился — выбери тариф, чтобы продолжить.", true)
	}
}

// ---------- listings & stats ----------

type UserRow struct {
	model.KorovaUser
	Active     bool   `json:"active"`
	Up         int64  `json:"up"`
	Down       int64  `json:"down"`
	LastOnline int64  `json:"lastOnline"`
	Online     bool   `json:"online"`
	SubURL     string `json:"subUrl"`
}

func (s *Service) ListUsers(query, filter string) ([]UserRow, error) {
	q := database.GetDB().Model(&model.KorovaUser{}).Order("id desc")
	if query = strings.TrimSpace(query); query != "" {
		like := "%" + strings.TrimPrefix(query, "@") + "%"
		q = q.Where("username LIKE ? OR first_name LIKE ? OR CAST(tg_id AS TEXT) LIKE ? OR note LIKE ?", like, like, like, like)
	}
	now := nowMs()
	switch filter {
	case "active":
		q = q.Where("banned = ? AND (access = ? OR (access = ? AND expires_at > ?))", false, model.KorovaAccessFree, model.KorovaAccessPaid, now)
	case "free":
		q = q.Where("access = ?", model.KorovaAccessFree)
	case "expired":
		q = q.Where("access = ? AND expires_at <= ?", model.KorovaAccessPaid, now)
	case "soon":
		q = q.Where("access = ? AND expires_at > ? AND expires_at <= ?", model.KorovaAccessPaid, now, now+3*dayMs)
	case "new":
		q = q.Where("access = ?", model.KorovaAccessNone)
	case "banned":
		q = q.Where("banned = ?", true)
	}
	var users []model.KorovaUser
	if err := q.Limit(2000).Find(&users).Error; err != nil {
		return nil, err
	}
	emails := make([]string, 0, len(users))
	for _, u := range users {
		if u.ClientEmail != "" {
			emails = append(emails, u.ClientEmail)
		}
	}
	traffic := map[string]xray.ClientTraffic{}
	if len(emails) > 0 {
		var rows []xray.ClientTraffic
		database.GetDB().Where("email IN ?", emails).Find(&rows)
		for _, r := range rows {
			traffic[r.Email] = r
		}
	}
	online := map[string]bool{}
	for _, e := range s.inboundSvc.GetOnlineClients() {
		online[e] = true
	}
	out := make([]UserRow, 0, len(users))
	for _, u := range users {
		t := traffic[u.ClientEmail]
		out = append(out, UserRow{
			KorovaUser: u, Active: HasAccess(&u), Up: t.Up, Down: t.Down,
			LastOnline: t.LastOnline, Online: online[u.ClientEmail], SubURL: s.SubURL(&u),
		})
	}
	return out, nil
}

func (s *Service) Payments(limit int) ([]model.KorovaPayment, error) {
	var out []model.KorovaPayment
	err := database.GetDB().Order("id desc").Limit(limit).Find(&out).Error
	return out, err
}

type DayPoint struct {
	Day     string `json:"day"`
	Stars   int    `json:"stars"`
	NewSubs int    `json:"newSubs"`
}

type NodeBrief struct {
	Id        int     `json:"id"`
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Status    string  `json:"status"`
	LatencyMs int     `json:"latencyMs"`
	CpuPct    float64 `json:"cpuPct"`
	MemPct    float64 `json:"memPct"`
	XrayState string  `json:"xrayState"`
}

type Overview struct {
	Mode         string      `json:"mode"`
	BotRunning   bool        `json:"botRunning"`
	BotUsername  string      `json:"botUsername"`
	BotError     string      `json:"botError"`
	Users        int64       `json:"users"`
	Active       int64       `json:"active"`
	Paid         int64       `json:"paid"`
	Free         int64       `json:"free"`
	Expired      int64       `json:"expired"`
	ExpiringSoon int64       `json:"expiringSoon"`
	New7d        int64       `json:"new7d"`
	Online       int         `json:"online"`
	Stars30d     int64       `json:"stars30d"`
	StarsTotal   int64       `json:"starsTotal"`
	Payments30d  int64       `json:"payments30d"`
	Series       []DayPoint  `json:"series"`
	Nodes        []NodeBrief `json:"nodes"`
	ServersReady bool        `json:"serversReady"`
	SubBaseReady bool        `json:"subBaseReady"`
	PlansReady   bool        `json:"plansReady"`
}

func (s *Service) Overview() (*Overview, error) {
	db := database.GetDB()
	st := LoadSettings()
	now := nowMs()
	o := &Overview{Mode: st.Mode}
	o.BotRunning, o.BotUsername, o.BotError = BotStatus()
	db.Model(&model.KorovaUser{}).Count(&o.Users)
	db.Model(&model.KorovaUser{}).Where("banned = ? AND (access = ? OR (access = ? AND expires_at > ?))", false, model.KorovaAccessFree, model.KorovaAccessPaid, now).Count(&o.Active)
	db.Model(&model.KorovaUser{}).Where("banned = ? AND access = ? AND expires_at > ?", false, model.KorovaAccessPaid, now).Count(&o.Paid)
	db.Model(&model.KorovaUser{}).Where("access = ?", model.KorovaAccessFree).Count(&o.Free)
	db.Model(&model.KorovaUser{}).Where("access = ? AND expires_at <= ?", model.KorovaAccessPaid, now).Count(&o.Expired)
	db.Model(&model.KorovaUser{}).Where("access = ? AND expires_at > ? AND expires_at <= ?", model.KorovaAccessPaid, now, now+3*dayMs).Count(&o.ExpiringSoon)
	db.Model(&model.KorovaUser{}).Where("created_at > ?", now-7*dayMs).Count(&o.New7d)
	db.Model(&model.KorovaPayment{}).Where("refunded = ? AND created_at > ?", false, now-30*dayMs).Select("COALESCE(SUM(stars),0)").Scan(&o.Stars30d)
	db.Model(&model.KorovaPayment{}).Where("refunded = ?", false).Select("COALESCE(SUM(stars),0)").Scan(&o.StarsTotal)
	db.Model(&model.KorovaPayment{}).Where("created_at > ?", now-30*dayMs).Count(&o.Payments30d)

	for _, e := range s.inboundSvc.GetOnlineClients() {
		if strings.HasPrefix(e, "tg") {
			o.Online++
		}
	}

	loc, _ := s.settingSvc.GetTimeLocation()
	if loc == nil {
		loc = time.Local
	}
	start := time.Now().In(loc).AddDate(0, 0, -29)
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	idx := map[string]int{}
	for i := 0; i < 30; i++ {
		d := start.AddDate(0, 0, i).Format("2006-01-02")
		idx[d] = i
		o.Series = append(o.Series, DayPoint{Day: d})
	}
	var pays []model.KorovaPayment
	db.Where("refunded = ? AND created_at >= ?", false, start.UnixMilli()).Find(&pays)
	for _, p := range pays {
		if i, ok := idx[time.UnixMilli(p.CreatedAt).In(loc).Format("2006-01-02")]; ok {
			o.Series[i].Stars += p.Stars
		}
	}
	var fresh []model.KorovaUser
	db.Select("created_at").Where("created_at >= ?", start.UnixMilli()).Find(&fresh)
	for _, u := range fresh {
		if i, ok := idx[time.UnixMilli(u.CreatedAt).In(loc).Format("2006-01-02")]; ok {
			o.Series[i].NewSubs++
		}
	}

	var nodes []model.Node
	db.Order("id asc").Find(&nodes)
	for _, n := range nodes {
		o.Nodes = append(o.Nodes, NodeBrief{
			Id: n.Id, Name: n.Name, Address: n.Address, Status: n.Status, LatencyMs: n.LatencyMs,
			CpuPct: n.CpuPct, MemPct: n.MemPct, XrayState: n.XrayState,
		})
	}
	o.ServersReady = len(s.validInboundIDs(st.InboundIDs)) > 0
	o.SubBaseReady = st.SubBase != ""
	if !o.SubBaseReady {
		uri, _ := s.settingSvc.GetSubURI()
		o.SubBaseReady = uri != ""
	}
	var plans int64
	db.Model(&model.KorovaPlan{}).Where("active = ?", true).Count(&plans)
	o.PlansReady = plans > 0
	return o, nil
}

// InboundOption lists inbounds the admin can hand out to subscribers.
type InboundOption struct {
	Id       int    `json:"id"`
	Remark   string `json:"remark"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
	Enable   bool   `json:"enable"`
	NodeID   int    `json:"nodeId"`
	NodeName string `json:"nodeName"`
	Tag      string `json:"tag"`
}

func (s *Service) InboundOptions() ([]InboundOption, error) {
	inbounds, err := s.inboundSvc.GetAllInbounds()
	if err != nil {
		return nil, err
	}
	names := map[int]string{}
	var nodes []model.Node
	database.GetDB().Find(&nodes)
	for _, n := range nodes {
		names[n.Id] = n.Name
	}
	out := make([]InboundOption, 0, len(inbounds))
	for _, ib := range inbounds {
		o := InboundOption{Id: ib.Id, Remark: ib.Remark, Protocol: string(ib.Protocol), Port: ib.Port, Enable: ib.Enable, Tag: ib.Tag, NodeName: "Основной сервер"}
		if ib.NodeID != nil {
			o.NodeID = *ib.NodeID
			o.NodeName = names[*ib.NodeID]
		}
		out = append(out, o)
	}
	return out, nil
}

// ---------- reminders ----------

// RunReminders notifies subscribers N days before expiry and once on expiry.
func (s *Service) RunReminders() {
	st := LoadSettings()
	now := nowMs()
	var users []model.KorovaUser
	database.GetDB().Where("access = ? AND banned = ? AND expires_at > ?", model.KorovaAccessPaid, false, now-dayMs).Find(&users)
	for _, u := range users {
		left := u.ExpiresAt - now
		if left <= 0 {
			if u.RemindedAt < u.ExpiresAt {
				notify(u.TgID, st.ExpiredText, true)
				database.GetDB().Model(&model.KorovaUser{}).Where("id = ?", u.Id).Update("reminded_at", now)
			}
			continue
		}
		for _, d := range st.RemindDays {
			edge := u.ExpiresAt - int64(d)*dayMs
			if now >= edge && u.RemindedAt < edge {
				notify(u.TgID, fmt.Sprintf("Подписка закончится через %s. Продли заранее, чтобы VPN не отключился.", pluralDays(d)), true)
				database.GetDB().Model(&model.KorovaUser{}).Where("id = ?", u.Id).Update("reminded_at", now)
				break
			}
		}
	}
}

func pluralDays(n int) string {
	m10, m100 := n%10, n%100
	switch {
	case m10 == 1 && m100 != 11:
		return itoa(n) + " день"
	case m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14):
		return itoa(n) + " дня"
	}
	return itoa(n) + " дней"
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]int(nil), a...)
	y := append([]int(nil), b...)
	sort.Ints(x)
	sort.Ints(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}
