package model

// Korova subscriber lifecycle. A subscriber owns exactly one panel client
// (ClientEmail) that is attached to every inbound chosen in Korova settings.
const (
	KorovaAccessNone = "none"
	KorovaAccessFree = "free"
	KorovaAccessPaid = "paid"

	KorovaPromoDays = "days"
	KorovaPromoFree = "free"

	KorovaModeInvite = "invite"
	KorovaModePaid   = "paid"
)

type KorovaUser struct {
	Id          int    `json:"id" gorm:"primaryKey;autoIncrement"`
	TgID        int64  `json:"tgId" gorm:"column:tg_id;uniqueIndex"`
	Username    string `json:"username"`
	FirstName   string `json:"firstName"`
	Access      string `json:"access" gorm:"default:none;index"`
	Devices     int    `json:"devices" gorm:"default:0"`
	ExpiresAt   int64  `json:"expiresAt" gorm:"default:0"`
	ClientEmail string `json:"clientEmail" gorm:"index"`
	SubID       string `json:"subId"`
	PlanID      int    `json:"planId" gorm:"default:0"`
	InvitedBy   string `json:"invitedBy"`
	Note        string `json:"note"`
	Banned      bool   `json:"banned" gorm:"default:false"`
	TrialUsed   bool   `json:"trialUsed" gorm:"default:false"`
	RemindedAt  int64  `json:"remindedAt" gorm:"default:0"`
	SpentStars  int    `json:"spentStars" gorm:"default:0"`
	LastSeenAt  int64  `json:"lastSeenAt" gorm:"default:0"`
	CreatedAt   int64  `json:"createdAt" gorm:"autoCreateTime:milli"`
	UpdatedAt   int64  `json:"updatedAt" gorm:"autoUpdateTime:milli"`
}

func (KorovaUser) TableName() string { return "korova_users" }

type KorovaPlan struct {
	Id         int    `json:"id" gorm:"primaryKey;autoIncrement"`
	Title      string `json:"title"`
	Devices    int    `json:"devices"`
	Days       int    `json:"days"`
	PriceStars int    `json:"priceStars"`
	Active     bool   `json:"active" gorm:"default:true"`
	Featured   bool   `json:"featured" gorm:"default:false"`
	Sort       int    `json:"sort" gorm:"default:0"`
}

func (KorovaPlan) TableName() string { return "korova_plans" }

type KorovaPromo struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	Code      string `json:"code" gorm:"uniqueIndex"`
	Kind      string `json:"kind" gorm:"default:days"`
	Days      int    `json:"days"`
	Devices   int    `json:"devices"`
	MaxUses   int    `json:"maxUses" gorm:"default:1"`
	Uses      int    `json:"uses" gorm:"default:0"`
	ExpiresAt int64  `json:"expiresAt" gorm:"default:0"`
	Active    bool   `json:"active" gorm:"default:true"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"createdAt" gorm:"autoCreateTime:milli"`
}

func (KorovaPromo) TableName() string { return "korova_promos" }

type KorovaPromoUse struct {
	Id      int   `json:"id" gorm:"primaryKey;autoIncrement"`
	PromoID int   `json:"promoId" gorm:"uniqueIndex:idx_korova_promo_use"`
	TgID    int64 `json:"tgId" gorm:"column:tg_id;uniqueIndex:idx_korova_promo_use"`
	UsedAt  int64 `json:"usedAt" gorm:"autoCreateTime:milli"`
}

func (KorovaPromoUse) TableName() string { return "korova_promo_uses" }

type KorovaPayment struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	TgID      int64  `json:"tgId" gorm:"column:tg_id;index"`
	PlanID    int    `json:"planId"`
	PlanTitle string `json:"planTitle"`
	Stars     int    `json:"stars"`
	Days      int    `json:"days"`
	Devices   int    `json:"devices"`
	ChargeID  string `json:"chargeId" gorm:"uniqueIndex"`
	Refunded  bool   `json:"refunded" gorm:"default:false"`
	CreatedAt int64  `json:"createdAt" gorm:"autoCreateTime:milli;index"`
}

func (KorovaPayment) TableName() string { return "korova_payments" }

type KorovaSetting struct {
	Key   string `json:"key" gorm:"primaryKey"`
	Value string `json:"value"`
}

func (KorovaSetting) TableName() string { return "korova_settings" }

// KorovaCascade records an applied entry→exit chain so it can be shown and removed.
type KorovaCascade struct {
	Id             int    `json:"id" gorm:"primaryKey;autoIncrement"`
	Name           string `json:"name"`
	EntryNodeID    int    `json:"entryNodeId"`
	EntryInboundID int    `json:"entryInboundId"`
	EntryTag       string `json:"entryTag"`
	ExitNodeID     int    `json:"exitNodeId"`
	ExitInboundID  int    `json:"exitInboundId"`
	OutboundTag    string `json:"outboundTag"`
	ClientEmail    string `json:"clientEmail"`
	DirectRu       bool   `json:"directRu" gorm:"default:true"`
	Status         string `json:"status"`
	LastError      string `json:"lastError"`
	CreatedAt      int64  `json:"createdAt" gorm:"autoCreateTime:milli"`
}

func (KorovaCascade) TableName() string { return "korova_cascades" }

// KorovaServer is a VPN server as the admin sees it: one node (or the main panel,
// NodeID 0) with the inbound Korova created on it and how users reach it.
type KorovaServer struct {
	Id             int    `json:"id" gorm:"primaryKey;autoIncrement"`
	NodeID         int    `json:"nodeId" gorm:"uniqueIndex"`
	Name           string `json:"name"`
	Country        string `json:"country"`
	Transport      string `json:"transport" gorm:"default:tcp"`
	SNI            string `json:"sni"`
	InboundID      int    `json:"inboundId"`
	InSub          bool   `json:"inSub" gorm:"default:true"`
	ViaServerID    int    `json:"viaServerId" gorm:"default:0"`
	KeepDirect     bool   `json:"keepDirect" gorm:"default:false"`
	EntryInboundID int    `json:"entryInboundId" gorm:"default:0"`
	CascadeID      int    `json:"cascadeId" gorm:"default:0"`
	CreatedAt      int64  `json:"createdAt" gorm:"autoCreateTime:milli"`
}

func (KorovaServer) TableName() string { return "korova_servers" }
