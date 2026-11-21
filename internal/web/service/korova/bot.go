package korova

import (
	"context"
	"errors"
	"fmt"
	"html"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mymmrac/telego"
	tu "github.com/mymmrac/telego/telegoutil"

	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
)

// One customer bot per panel; guarded by botMu so Start/Stop from the settings
// page never races the polling goroutine.
var (
	botMu      sync.Mutex
	botCancel  context.CancelFunc
	botInst    *telego.Bot
	botName    string
	botErr     string
	awaitPromo sync.Map
)

const (
	happIOS     = "https://apps.apple.com/app/happ-proxy-utility/id6504287215"
	happAndroid = "https://play.google.com/store/apps/details?id=com.happproxy"
)

func BotStatus() (running bool, username, lastErr string) {
	botMu.Lock()
	defer botMu.Unlock()
	return botInst != nil, botName, botErr
}

func StopBot() {
	botMu.Lock()
	defer botMu.Unlock()
	if botCancel != nil {
		botCancel()
	}
	botCancel, botInst, botName = nil, nil, ""
}

// RestartBot (re)starts polling from current settings; safe to call at any time.
func RestartBot(svc *Service) {
	StopBot()
	st := LoadSettings()
	botMu.Lock()
	defer botMu.Unlock()
	botErr = ""
	if !st.BotEnabled || strings.TrimSpace(st.BotToken) == "" {
		return
	}
	bot, err := telego.NewBot(strings.TrimSpace(st.BotToken), telego.WithDiscardLogger())
	if err != nil {
		botErr = "Токен не подходит: " + err.Error()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	me, err := bot.GetMe(ctx)
	if err != nil {
		cancel()
		botErr = "Telegram не принял токен: " + err.Error()
		return
	}
	updates, err := bot.UpdatesViaLongPolling(ctx, &telego.GetUpdatesParams{
		Timeout:        30,
		AllowedUpdates: []string{"message", "callback_query", "pre_checkout_query"},
	})
	if err != nil {
		cancel()
		botErr = err.Error()
		return
	}
	botInst, botCancel, botName = bot, cancel, me.Username
	_ = bot.SetMyCommands(ctx, &telego.SetMyCommandsParams{Commands: []telego.BotCommand{
		{Command: "start", Description: "Главное меню"},
		{Command: "connect", Description: "Подключить устройство"},
		{Command: "buy", Description: "Тарифы и продление"},
		{Command: "promo", Description: "Ввести промокод"},
		{Command: "help", Description: "Как подключиться"},
	}})
	h := &botHandler{svc: svc, bot: bot}
	go func() {
		for upd := range updates {
			u := upd
			go h.safe(ctx, u)
		}
	}()
	logger.Infof("korova bot @%s started", me.Username)
	go svc.ApplySubscriptionLook()
}

// notify is fire-and-forget: a user who blocked the bot must not break callers.
func notify(tgID int64, text string, withMenu bool) {
	botMu.Lock()
	bot := botInst
	botMu.Unlock()
	if bot == nil || tgID == 0 {
		return
	}
	params := &telego.SendMessageParams{ChatID: tu.ID(tgID), Text: html.EscapeString(text), ParseMode: telego.ModeHTML}
	if withMenu {
		params.ReplyMarkup = tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Открыть меню", "menu")))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, _ = bot.SendMessage(ctx, params)
}

// Broadcast sends a plain message to every subscriber matching the audience.
func (s *Service) Broadcast(text, audience string) (int, error) {
	if strings.TrimSpace(text) == "" {
		return 0, errors.New("пустое сообщение")
	}
	if running, _, _ := BotStatus(); !running {
		return 0, errors.New("бот не запущен")
	}
	rows, err := s.ListUsers("", audience)
	if err != nil {
		return 0, err
	}
	go func() {
		for _, r := range rows {
			if r.Banned {
				continue
			}
			notify(r.TgID, text, true)
			time.Sleep(60 * time.Millisecond)
		}
	}()
	return len(rows), nil
}

type botHandler struct {
	svc *Service
	bot *telego.Bot
}

func btn(text, data string) telego.InlineKeyboardButton {
	return tu.InlineKeyboardButton(text).WithCallbackData(data)
}

func urlBtn(text, url string) telego.InlineKeyboardButton {
	return tu.InlineKeyboardButton(text).WithURL(url)
}

func primary(b telego.InlineKeyboardButton) telego.InlineKeyboardButton {
	b.Style = "primary"
	return b
}

func (h *botHandler) safe(ctx context.Context, upd telego.Update) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("korova bot panic:", r)
		}
	}()
	switch {
	case upd.PreCheckoutQuery != nil:
		h.onPreCheckout(ctx, upd.PreCheckoutQuery)
	case upd.Message != nil:
		h.onMessage(ctx, upd.Message)
	case upd.CallbackQuery != nil:
		h.onCallback(ctx, upd.CallbackQuery)
	}
}

func (h *botHandler) send(ctx context.Context, chatID int64, text string, kb *telego.InlineKeyboardMarkup) {
	p := &telego.SendMessageParams{ChatID: tu.ID(chatID), Text: text, ParseMode: telego.ModeHTML,
		LinkPreviewOptions: &telego.LinkPreviewOptions{IsDisabled: true}}
	if kb != nil {
		p.ReplyMarkup = kb
	}
	if _, err := h.bot.SendMessage(ctx, p); err != nil {
		logger.Warning("korova bot send:", err)
	}
}

// show edits the message the button lives on, so navigation stays in one bubble.
func (h *botHandler) show(ctx context.Context, chatID int64, msgID int, text string, kb *telego.InlineKeyboardMarkup) {
	if msgID == 0 {
		h.send(ctx, chatID, text, kb)
		return
	}
	_, err := h.bot.EditMessageText(ctx, &telego.EditMessageTextParams{
		ChatID: tu.ID(chatID), MessageID: msgID, Text: text, ParseMode: telego.ModeHTML,
		LinkPreviewOptions: &telego.LinkPreviewOptions{IsDisabled: true}, ReplyMarkup: kb,
	})
	if err != nil && !strings.Contains(err.Error(), "message is not modified") {
		h.send(ctx, chatID, text, kb)
	}
}

func (h *botHandler) onMessage(ctx context.Context, m *telego.Message) {
	if m.From == nil || m.Chat.Type != "private" {
		return
	}
	st := LoadSettings()
	u, _, err := h.svc.Touch(m.From.ID, m.From.Username, m.From.FirstName)
	if err != nil {
		h.send(ctx, m.Chat.ID, "Что-то пошло не так. Попробуй ещё раз через минуту.", nil)
		return
	}
	h.rememberAdmin(st, m.From)

	if m.SuccessfulPayment != nil {
		h.onPaid(ctx, m)
		return
	}
	text := strings.TrimSpace(m.Text)

	if _, waiting := awaitPromo.LoadAndDelete(m.From.ID); waiting && !strings.HasPrefix(text, "/") {
		h.redeem(ctx, m.Chat.ID, 0, text)
		return
	}

	cmd, arg, _ := strings.Cut(text, " ")
	switch strings.ToLower(cmd) {
	case "/start":
		if arg = strings.TrimSpace(arg); arg != "" {
			h.redeem(ctx, m.Chat.ID, 0, arg)
			return
		}
		h.menu(ctx, m.Chat.ID, 0, u)
	case "/connect":
		h.connect(ctx, m.Chat.ID, 0, u)
	case "/buy":
		h.plans(ctx, m.Chat.ID, 0, u)
	case "/promo":
		if arg = strings.TrimSpace(arg); arg != "" {
			h.redeem(ctx, m.Chat.ID, 0, arg)
			return
		}
		h.askPromo(ctx, m.Chat.ID, 0, m.From.ID)
	case "/help":
		h.help(ctx, m.Chat.ID, 0)
	case "/admin", "/stats":
		h.admin(ctx, m.Chat.ID, 0, m.From)
	case "/invite":
		h.invite(ctx, m.Chat.ID, m.From, arg)
	default:
		h.menu(ctx, m.Chat.ID, 0, u)
	}
}

func (h *botHandler) onCallback(ctx context.Context, q *telego.CallbackQuery) {
	_ = h.bot.AnswerCallbackQuery(ctx, &telego.AnswerCallbackQueryParams{CallbackQueryID: q.ID})
	if q.Message == nil {
		return
	}
	chatID := q.Message.GetChat().ID
	msgID := q.Message.GetMessageID()
	u, _, err := h.svc.Touch(q.From.ID, q.From.Username, q.From.FirstName)
	if err != nil {
		return
	}
	action, arg, _ := strings.Cut(q.Data, ":")
	switch action {
	case "menu":
		h.menu(ctx, chatID, msgID, u)
	case "connect":
		h.connect(ctx, chatID, msgID, u)
	case "plans":
		h.plans(ctx, chatID, msgID, u)
	case "buy":
		id, _ := strconv.Atoi(arg)
		h.invoice(ctx, chatID, u, id)
	case "trial":
		nu, tErr := h.svc.StartTrial(u.TgID)
		if tErr != nil {
			h.show(ctx, chatID, msgID, html.EscapeString(tErr.Error()), tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Назад", "menu"))))
			return
		}
		h.connect(ctx, chatID, msgID, nu)
	case "promo":
		h.askPromo(ctx, chatID, msgID, q.From.ID)
	case "help":
		h.help(ctx, chatID, msgID)
	case "admin":
		h.admin(ctx, chatID, msgID, &q.From)
	case "adm_invite":
		h.invite(ctx, chatID, &q.From, arg)
	case "adm_mode":
		st := LoadSettings()
		if !st.IsAdmin(q.From.ID, q.From.Username) {
			return
		}
		if st.Mode == model.KorovaModePaid {
			st.Mode = model.KorovaModeInvite
		} else {
			st.Mode = model.KorovaModePaid
		}
		_ = h.svc.SaveSettings(st)
		h.admin(ctx, chatID, msgID, &q.From)
	}
}

func (h *botHandler) rememberAdmin(st Settings, from *telego.User) {
	if from == nil || !st.IsAdmin(from.ID, from.Username) {
		return
	}
	for _, id := range st.AdminIDs {
		if id == from.ID {
			return
		}
	}
	st.AdminIDs = append(st.AdminIDs, from.ID)
	_ = saveSettings(st)
}

func fmtDate(ms int64) string {
	months := []string{"января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"}
	t := time.UnixMilli(ms)
	return fmt.Sprintf("%d %s %d", t.Day(), months[t.Month()-1], t.Year())
}

func devicesWord(n int) string {
	m10, m100 := n%10, n%100
	switch {
	case m10 == 1 && m100 != 11:
		return itoa(n) + " устройство"
	case m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14):
		return itoa(n) + " устройства"
	}
	return itoa(n) + " устройств"
}

func statusLine(u *model.KorovaUser) string {
	switch {
	case u.Banned:
		return "Доступ заблокирован. Если это ошибка, напиши в поддержку."
	case u.Access == model.KorovaAccessFree:
		return fmt.Sprintf("Доступ по приглашению · %s", devicesWord(max(u.Devices, 1)))
	case HasAccess(u):
		left := (u.ExpiresAt - nowMs()) / dayMs
		return fmt.Sprintf("Подписка до <b>%s</b> · осталось %s · %s", fmtDate(u.ExpiresAt), pluralDays(int(left)), devicesWord(max(u.Devices, 1)))
	case u.ExpiresAt > 0:
		return fmt.Sprintf("Подписка закончилась %s.", fmtDate(u.ExpiresAt))
	}
	return ""
}

func (h *botHandler) menu(ctx context.Context, chatID int64, msgID int, u *model.KorovaUser) {
	st := LoadSettings()
	var b strings.Builder
	fmt.Fprintf(&b, "<b>%s</b>\n\n", html.EscapeString(st.BrandName))
	if line := statusLine(u); line != "" {
		b.WriteString(line)
	} else {
		b.WriteString(html.EscapeString(st.WelcomeText))
	}
	rows := [][]telego.InlineKeyboardButton{}
	switch {
	case HasAccess(u):
		rows = append(rows, tu.InlineKeyboardRow(primary(btn("Подключить устройство", "connect"))))
		if u.Access == model.KorovaAccessPaid || st.Mode == model.KorovaModePaid {
			rows = append(rows, tu.InlineKeyboardRow(btn("Продлить", "plans"), btn("Промокод", "promo")))
		} else {
			rows = append(rows, tu.InlineKeyboardRow(btn("Промокод", "promo")))
		}
	case u.Banned:
	case st.Mode == model.KorovaModePaid:
		rows = append(rows, tu.InlineKeyboardRow(primary(btn("Выбрать тариф", "plans"))))
		if st.TrialDays > 0 && !u.TrialUsed {
			rows = append(rows, tu.InlineKeyboardRow(btn(fmt.Sprintf("Попробовать %s бесплатно", pluralDays(st.TrialDays)), "trial")))
		}
		rows = append(rows, tu.InlineKeyboardRow(btn("У меня есть промокод", "promo")))
	default:
		b.WriteString("\n\n" + html.EscapeString(st.InviteOnlyText))
		rows = append(rows, tu.InlineKeyboardRow(primary(btn("Ввести промокод", "promo"))))
	}
	bottom := tu.InlineKeyboardRow(btn("Как подключиться", "help"))
	if link := st.SupportLink(); link != "" {
		bottom = append(bottom, urlBtn("Поддержка", link))
	}
	rows = append(rows, bottom)
	if st.IsAdmin(u.TgID, u.Username) {
		rows = append(rows, tu.InlineKeyboardRow(btn("Админка", "admin")))
	}
	h.show(ctx, chatID, msgID, b.String(), tu.InlineKeyboard(rows...))
}

func (h *botHandler) connect(ctx context.Context, chatID int64, msgID int, u *model.KorovaUser) {
	if !HasAccess(u) {
		h.menu(ctx, chatID, msgID, u)
		return
	}
	if u.SubID == "" {
		mutateMu.Lock()
		err := h.svc.applyClient(u)
		mutateMu.Unlock()
		if err != nil {
			logger.Warning("korova connect:", err)
			h.show(ctx, chatID, msgID, "Не получилось выдать доступ: серверы ещё не настроены. Администратор уже видит проблему в панели.", tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Назад", "menu"))))
			return
		}
	}
	link := h.svc.SubURL(u)
	if link == "" {
		h.show(ctx, chatID, msgID, "Ссылка подписки пока не настроена. Напиши в поддержку.", tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Назад", "menu"))))
		return
	}
	text := fmt.Sprintf("<b>Твоя ссылка подписки</b>\n<code>%s</code>\n\n"+
		"1. Установи Happ или Incy.\n"+
		"2. Нажми «Скопировать ссылку» ниже.\n"+
		"3. В приложении нажми «+» и выбери «Вставить из буфера».\n\n"+
		"Ссылка одна на все серверы и устройства. Лимит: %s.", html.EscapeString(link), devicesWord(max(u.Devices, 1)))
	copyBtn := tu.InlineKeyboardButton("Скопировать ссылку").WithCopyText(&telego.CopyTextButton{Text: link})
	copyBtn.Style = "success"
	kb := tu.InlineKeyboard(
		tu.InlineKeyboardRow(copyBtn),
		tu.InlineKeyboardRow(urlBtn("Открыть страницу подключения", link)),
		tu.InlineKeyboardRow(urlBtn("Happ для iPhone", happIOS), urlBtn("Happ для Android", happAndroid)),
		tu.InlineKeyboardRow(btn("Назад", "menu")),
	)
	h.show(ctx, chatID, msgID, text, kb)
}

func (h *botHandler) help(ctx context.Context, chatID int64, msgID int) {
	text := "<b>Как подключиться</b>\n\n" +
		"iPhone и iPad: приложение Happ из App Store.\n" +
		"Android: Happ из Google Play или Incy.\n" +
		"Windows и Mac: Happ.\n\n" +
		"Добавь ссылку подписки из раздела «Подключить устройство». Приложение само подтянет все серверы и будет обновлять их.\n\n" +
		"Если подписка закончится, вместо серверов появится строка «Продлите подписку». После оплаты всё вернётся само."
	h.show(ctx, chatID, msgID, text, tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Назад", "menu"))))
}

func (h *botHandler) plans(ctx context.Context, chatID int64, msgID int, u *model.KorovaUser) {
	st := LoadSettings()
	if st.Mode != model.KorovaModePaid && u.Access != model.KorovaAccessPaid {
		h.show(ctx, chatID, msgID, html.EscapeString(st.InviteOnlyText), tu.InlineKeyboard(
			tu.InlineKeyboardRow(primary(btn("Ввести промокод", "promo"))),
			tu.InlineKeyboardRow(btn("Назад", "menu"))))
		return
	}
	plans, _ := h.svc.Plans(true)
	if len(plans) == 0 {
		h.show(ctx, chatID, msgID, "Тарифы скоро появятся.", tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Назад", "menu"))))
		return
	}
	var b strings.Builder
	b.WriteString("<b>Тарифы</b>\nОплата звёздами Telegram. Дни добавляются к текущей подписке.\n")
	rows := [][]telego.InlineKeyboardButton{}
	for _, p := range plans {
		label := fmt.Sprintf("%s · %s · %s — %d ★", p.Title, devicesWord(p.Devices), pluralDays(p.Days), p.PriceStars)
		b2 := btn(label, "buy:"+itoa(p.Id))
		if p.Featured {
			b2 = primary(b2)
		}
		rows = append(rows, tu.InlineKeyboardRow(b2))
	}
	rows = append(rows, tu.InlineKeyboardRow(btn("Назад", "menu")))
	h.show(ctx, chatID, msgID, b.String(), tu.InlineKeyboard(rows...))
}

func (h *botHandler) invoice(ctx context.Context, chatID int64, u *model.KorovaUser, planID int) {
	p, err := h.svc.GetPlan(planID)
	if err != nil || !p.Active {
		h.send(ctx, chatID, "Этот тариф больше недоступен.", nil)
		return
	}
	st := LoadSettings()
	_, err = h.bot.SendInvoice(ctx, &telego.SendInvoiceParams{
		ChatID:      tu.ID(chatID),
		Title:       fmt.Sprintf("%s — %s", st.BrandName, p.Title),
		Description: fmt.Sprintf("%s на %s", devicesWord(p.Devices), pluralDays(p.Days)),
		Payload:     fmt.Sprintf("plan:%d:%d", p.Id, u.TgID),
		Currency:    "XTR",
		Prices:      []telego.LabeledPrice{{Label: p.Title, Amount: p.PriceStars}},
	})
	if err != nil {
		logger.Warning("korova invoice:", err)
		h.send(ctx, chatID, "Не удалось выставить счёт. Попробуй позже.", nil)
	}
}

func parsePayload(payload string) (planID int, tgID int64, ok bool) {
	parts := strings.Split(payload, ":")
	if len(parts) != 3 || parts[0] != "plan" {
		return 0, 0, false
	}
	pid, err1 := strconv.Atoi(parts[1])
	uid, err2 := strconv.ParseInt(parts[2], 10, 64)
	return pid, uid, err1 == nil && err2 == nil
}

func (h *botHandler) onPreCheckout(ctx context.Context, q *telego.PreCheckoutQuery) {
	answer := &telego.AnswerPreCheckoutQueryParams{PreCheckoutQueryID: q.ID, Ok: true}
	planID, tgID, ok := parsePayload(q.InvoicePayload)
	p, err := h.svc.GetPlan(planID)
	switch {
	case !ok || tgID != q.From.ID:
		answer.Ok, answer.ErrorMessage = false, "Счёт устарел, открой тарифы заново."
	case err != nil || !p.Active:
		answer.Ok, answer.ErrorMessage = false, "Тариф больше недоступен."
	case q.Currency != "XTR" || q.TotalAmount != p.PriceStars:
		answer.Ok, answer.ErrorMessage = false, "Цена изменилась, открой тарифы заново."
	}
	if u, uErr := h.svc.GetUser(q.From.ID); uErr == nil && u.Banned {
		answer.Ok, answer.ErrorMessage = false, "Доступ заблокирован."
	}
	_ = h.bot.AnswerPreCheckoutQuery(ctx, answer)
}

func (h *botHandler) onPaid(ctx context.Context, m *telego.Message) {
	sp := m.SuccessfulPayment
	planID, _, ok := parsePayload(sp.InvoicePayload)
	if !ok {
		return
	}
	u, plan, err := h.svc.ApplyPayment(m.From.ID, planID, sp.TotalAmount, sp.TelegramPaymentChargeID)
	if err != nil {
		logger.Error("korova payment apply:", err)
		h.send(ctx, m.Chat.ID, "Оплата прошла, но доступ не выдался автоматически. Мы уже разбираемся — напиши в поддержку, если не исправится за 10 минут.", nil)
		h.alertAdmins(fmt.Sprintf("Ошибка выдачи после оплаты: %d, %s", m.From.ID, err.Error()))
		return
	}
	h.send(ctx, m.Chat.ID, fmt.Sprintf("Оплата получена. %s активен до <b>%s</b>.", html.EscapeString(plan.Title), fmtDate(u.ExpiresAt)), nil)
	h.connect(ctx, m.Chat.ID, 0, u)
	h.alertAdmins(fmt.Sprintf("Новая оплата: @%s, %s, %d ★", u.Username, plan.Title, sp.TotalAmount))
}

func (h *botHandler) alertAdmins(text string) {
	for _, id := range LoadSettings().AdminIDs {
		notify(id, text, false)
	}
}

func (h *botHandler) askPromo(ctx context.Context, chatID int64, msgID int, tgID int64) {
	awaitPromo.Store(tgID, true)
	h.show(ctx, chatID, msgID, "Отправь промокод одним сообщением.", tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Отмена", "menu"))))
}

func (h *botHandler) redeem(ctx context.Context, chatID int64, msgID int, code string) {
	u, p, err := h.svc.RedeemPromo(chatID, code)
	if err != nil {
		kb := tu.InlineKeyboard(tu.InlineKeyboardRow(btn("Попробовать ещё раз", "promo")), tu.InlineKeyboardRow(btn("Меню", "menu")))
		h.show(ctx, chatID, msgID, html.EscapeString(promoErrText(err)), kb)
		return
	}
	var text string
	if p.Kind == model.KorovaPromoFree {
		text = fmt.Sprintf("Приглашение принято. Тебе открыт доступ на %s.", devicesWord(max(u.Devices, 1)))
	} else {
		text = fmt.Sprintf("Промокод применён: +%s. Подписка до %s.", pluralDays(p.Days), fmtDate(u.ExpiresAt))
	}
	h.send(ctx, chatID, text, nil)
	h.connect(ctx, chatID, 0, u)
}

func promoErrText(err error) string {
	for _, known := range []error{ErrPromoNotFound, ErrPromoUsed, ErrPromoExpired, ErrPromoPaidMode, ErrBanned, ErrNoServers} {
		if errors.Is(err, known) {
			if known == ErrNoServers {
				return "Промокод принят, но серверы ещё не настроены. Администратор получит уведомление."
			}
			return known.Error() + "."
		}
	}
	return "Не удалось применить промокод. Попробуй ещё раз."
}

func (h *botHandler) admin(ctx context.Context, chatID int64, msgID int, from *telego.User) {
	st := LoadSettings()
	if from == nil || !st.IsAdmin(from.ID, from.Username) {
		return
	}
	o, err := h.svc.Overview()
	if err != nil {
		return
	}
	mode := "по приглашениям"
	next := "Включить подписку"
	if st.Mode == model.KorovaModePaid {
		mode, next = "платная подписка", "Вернуть режим приглашений"
	}
	text := fmt.Sprintf("<b>Админка</b>\n\nРежим: %s\nПодписчиков: %d, активны: %d, онлайн: %d\nПлатных: %d, по приглашению: %d\nИстекают за 3 дня: %d\nЗвёзд за 30 дней: %d",
		mode, o.Users, o.Active, o.Online, o.Paid, o.Free, o.ExpiringSoon, o.Stars30d)
	kb := tu.InlineKeyboard(
		tu.InlineKeyboardRow(primary(btn("Приглашение на 1 устройство", "adm_invite:1"))),
		tu.InlineKeyboardRow(btn("На 3 устройства", "adm_invite:3"), btn("На 5", "adm_invite:5")),
		tu.InlineKeyboardRow(btn(next, "adm_mode")),
		tu.InlineKeyboardRow(btn("Назад", "menu")),
	)
	h.show(ctx, chatID, msgID, text, kb)
}

// invite issues a single-use free-access code and a deep link that applies it on /start.
func (h *botHandler) invite(ctx context.Context, chatID int64, from *telego.User, arg string) {
	st := LoadSettings()
	if from == nil || !st.IsAdmin(from.ID, from.Username) {
		return
	}
	devices, _ := strconv.Atoi(strings.TrimSpace(arg))
	if devices < 1 {
		devices = 1
	}
	p := &model.KorovaPromo{Kind: model.KorovaPromoFree, Devices: devices, MaxUses: 1, Active: true,
		Note: "Приглашение из бота от @" + from.Username}
	if st.Mode == model.KorovaModePaid {
		p.Kind, p.Days = model.KorovaPromoDays, 30
	}
	if err := h.svc.SavePromo(p); err != nil {
		h.send(ctx, chatID, html.EscapeString(err.Error()), nil)
		return
	}
	_, name, _ := BotStatus()
	link := fmt.Sprintf("https://t.me/%s?start=%s", name, p.Code)
	h.send(ctx, chatID, fmt.Sprintf("Приглашение на %s, одноразовое:\n%s\n\nКод: <code>%s</code>", devicesWord(devices), link, p.Code),
		tu.InlineKeyboard(tu.InlineKeyboardRow(tu.InlineKeyboardButton("Скопировать ссылку").WithCopyText(&telego.CopyTextButton{Text: link}))))
}
