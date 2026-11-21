package controller

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
	"github.com/mhsanaei/3x-ui/v3/internal/web/entity"
	"github.com/mhsanaei/3x-ui/v3/internal/web/service/korova"
)

// KorovaController serves the subscriber, tariff, bot and cascade screens.
type KorovaController struct {
	svc korova.Service
}

func NewKorovaController(g *gin.RouterGroup) *KorovaController {
	a := &KorovaController{}
	g.GET("/overview", a.overview)
	g.GET("/settings", a.getSettings)
	g.POST("/settings", a.saveSettings)
	g.POST("/bot/restart", a.restartBot)
	g.GET("/inbounds", a.inbounds)
	g.GET("/users", a.users)
	g.POST("/users/:id/action", a.userAction)
	g.POST("/users/:id/del", a.deleteUser)
	g.POST("/sync", a.sync)
	g.GET("/plans", a.plans)
	g.POST("/plans", a.savePlan)
	g.POST("/plans/:id/del", a.deletePlan)
	g.GET("/promos", a.promos)
	g.POST("/promos", a.savePromo)
	g.POST("/promos/:id/del", a.deletePromo)
	g.GET("/payments", a.payments)
	g.POST("/broadcast", a.broadcast)
	g.GET("/cascades", a.cascades)
	g.POST("/cascades", a.createCascade)
	g.POST("/cascades/:id/del", a.deleteCascade)
	g.POST("/nodes/connect", a.connectNode)
	g.GET("/servers", a.servers)
	g.POST("/servers/publish", a.publishServer)
	g.POST("/servers/:id", a.updateServer)
	g.POST("/servers/:id/del", a.removeServer)
	g.GET("/nodes/install-command", a.nodeInstallCommand)
	return a
}

// korovaReply puts the service error itself in msg: the Korova UI shows it verbatim.
func korovaReply(c *gin.Context, okMsg string, obj any, err error) {
	if err != nil {
		logger.Warningf("korova %s %s: %v", c.Request.Method, c.Request.URL.Path, err)
		c.JSON(http.StatusOK, entity.Msg{Success: false, Msg: err.Error(), Obj: obj})
		return
	}
	c.JSON(http.StatusOK, entity.Msg{Success: true, Msg: okMsg, Obj: obj})
}

func idParam(c *gin.Context) int {
	id, _ := strconv.Atoi(c.Param("id"))
	return id
}

func (a *KorovaController) overview(c *gin.Context) {
	o, err := a.svc.Overview()
	korovaReply(c, "", o, err)
}

const tokenMask = "••••"

type korovaSettingsView struct {
	korova.Settings
	BotTokenSet bool `json:"botTokenSet"`
}

func (a *KorovaController) getSettings(c *gin.Context) {
	st := a.svc.Settings()
	view := korovaSettingsView{Settings: st, BotTokenSet: st.BotToken != ""}
	if len(st.BotToken) > 6 {
		view.BotToken = tokenMask + st.BotToken[len(st.BotToken)-4:]
	}
	korovaReply(c, "", view, nil)
}

func (a *KorovaController) saveSettings(c *gin.Context) {
	var next korova.Settings
	if err := c.ShouldBindJSON(&next); err != nil {
		korovaReply(c, "Не удалось прочитать настройки", nil, err)
		return
	}
	prev := a.svc.Settings()
	if next.BotToken == "" || strings.HasPrefix(next.BotToken, tokenMask) {
		next.BotToken = prev.BotToken
	}
	if len(next.AdminIDs) == 0 {
		next.AdminIDs = prev.AdminIDs
	}
	if err := a.svc.SaveSettings(next); err != nil {
		korovaReply(c, "Не удалось сохранить", nil, err)
		return
	}
	if next.BotToken != prev.BotToken || next.BotEnabled != prev.BotEnabled {
		korova.RestartBot(&a.svc)
	}
	korovaReply(c, "Сохранено", nil, nil)
}

func (a *KorovaController) restartBot(c *gin.Context) {
	korova.RestartBot(&a.svc)
	running, name, errText := korova.BotStatus()
	korovaReply(c, "", gin.H{"running": running, "username": name, "error": errText}, nil)
}

func (a *KorovaController) inbounds(c *gin.Context) {
	out, err := a.svc.InboundOptions()
	korovaReply(c, "", out, err)
}

func (a *KorovaController) users(c *gin.Context) {
	out, err := a.svc.ListUsers(c.Query("q"), c.Query("filter"))
	korovaReply(c, "", out, err)
}

func (a *KorovaController) userAction(c *gin.Context) {
	var act korova.AdminAction
	if err := c.ShouldBindJSON(&act); err != nil {
		korovaReply(c, "Неверный запрос", nil, err)
		return
	}
	u, err := a.svc.AdminUpdate(idParam(c), act)
	korovaReply(c, "Готово", u, err)
}

func (a *KorovaController) deleteUser(c *gin.Context) {
	korovaReply(c, "Подписчик удалён", nil, a.svc.DeleteUser(idParam(c)))
}

func (a *KorovaController) sync(c *gin.Context) {
	n, err := a.svc.SyncAll()
	korovaReply(c, "Синхронизировано", gin.H{"synced": n}, err)
}

func (a *KorovaController) plans(c *gin.Context) {
	out, err := a.svc.Plans(false)
	korovaReply(c, "", out, err)
}

func (a *KorovaController) savePlan(c *gin.Context) {
	var p model.KorovaPlan
	if err := c.ShouldBindJSON(&p); err != nil {
		korovaReply(c, "Неверный тариф", nil, err)
		return
	}
	err := a.svc.SavePlan(&p)
	korovaReply(c, "Тариф сохранён", p, err)
}

func (a *KorovaController) deletePlan(c *gin.Context) {
	korovaReply(c, "Тариф удалён", nil, a.svc.DeletePlan(idParam(c)))
}

func (a *KorovaController) promos(c *gin.Context) {
	out, err := a.svc.Promos()
	korovaReply(c, "", out, err)
}

func (a *KorovaController) savePromo(c *gin.Context) {
	var p model.KorovaPromo
	if err := c.ShouldBindJSON(&p); err != nil {
		korovaReply(c, "Неверный промокод", nil, err)
		return
	}
	err := a.svc.SavePromo(&p)
	korovaReply(c, "Промокод сохранён", p, err)
}

func (a *KorovaController) deletePromo(c *gin.Context) {
	korovaReply(c, "Промокод удалён", nil, a.svc.DeletePromo(idParam(c)))
}

func (a *KorovaController) payments(c *gin.Context) {
	out, err := a.svc.Payments(500)
	korovaReply(c, "", out, err)
}

func (a *KorovaController) broadcast(c *gin.Context) {
	var req struct {
		Text     string `json:"text"`
		Audience string `json:"audience"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		korovaReply(c, "Неверный запрос", nil, err)
		return
	}
	n, err := a.svc.Broadcast(req.Text, req.Audience)
	korovaReply(c, "Рассылка запущена", gin.H{"recipients": n}, err)
}

func (a *KorovaController) cascades(c *gin.Context) {
	out, err := a.svc.Cascades()
	korovaReply(c, "", out, err)
}

func (a *KorovaController) createCascade(c *gin.Context) {
	var req korova.CascadeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		korovaReply(c, "Неверный запрос", nil, err)
		return
	}
	out, err := a.svc.CreateCascade(req)
	korovaReply(c, "Каскад настроен", out, err)
}

func (a *KorovaController) deleteCascade(c *gin.Context) {
	korovaReply(c, "Каскад удалён", nil, a.svc.DeleteCascade(idParam(c)))
}

func (a *KorovaController) connectNode(c *gin.Context) {
	var req korova.ConnectNodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		korovaReply(c, "", nil, err)
		return
	}
	res, err := a.svc.ConnectNode(req)
	msg := ""
	if err == nil && res.Id > 0 {
		msg = "Узел подключён"
	}
	korovaReply(c, msg, res, err)
}

func (a *KorovaController) nodeInstallCommand(c *gin.Context) {
	korovaReply(c, "", gin.H{"command": korova.NodeInstallCommand()}, nil)
}

func (a *KorovaController) servers(c *gin.Context) {
	out, err := a.svc.Servers()
	korovaReply(c, "", out, err)
}

func (a *KorovaController) publishServer(c *gin.Context) {
	var req korova.PublishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		korovaReply(c, "", nil, err)
		return
	}
	srv, err := a.svc.PublishServer(req)
	korovaReply(c, "Сервер добавлен в подписку", srv, err)
}

func (a *KorovaController) updateServer(c *gin.Context) {
	var p korova.ServerPatch
	if err := c.ShouldBindJSON(&p); err != nil {
		korovaReply(c, "", nil, err)
		return
	}
	srv, err := a.svc.UpdateServer(idParam(c), p)
	korovaReply(c, "Сохранено", srv, err)
}

func (a *KorovaController) removeServer(c *gin.Context) {
	korovaReply(c, "Сервер убран из Korova", nil, a.svc.RemoveServer(idParam(c)))
}
