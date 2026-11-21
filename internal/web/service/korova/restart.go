package korova

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/logger"
	"github.com/mhsanaei/3x-ui/v3/internal/web/runtime"
)

var (
	restartMu     sync.Mutex
	restartTimers = map[int]*time.Timer{}
)

// restartNodeXrayLater restarts Xray on a node shortly after Korova's last change
// there. Hot-applied XHTTP listeners can close without reopening, and template
// edits (cascade outbounds and routing) only take effect after a restart.
// Several changes in a row collapse into one restart. The main server restarts
// on its own through SetToNeedRestart.
func (s *Service) restartNodeXrayLater(nodeID int) {
	if nodeID <= 0 {
		return
	}
	restartMu.Lock()
	defer restartMu.Unlock()
	if t, ok := restartTimers[nodeID]; ok {
		t.Stop()
	}
	restartTimers[nodeID] = time.AfterFunc(4*time.Second, func() {
		restartMu.Lock()
		delete(restartTimers, nodeID)
		restartMu.Unlock()
		if err := restartNodeXray(nodeID); err != nil {
			logger.Warning("korova: restart xray on node", nodeID, err)
		}
	})
}

func restartNodeXray(nodeID int) error {
	node := &model.Node{}
	if err := database.GetDB().First(node, nodeID).Error; err != nil {
		return err
	}
	mgr := runtime.GetManager()
	if mgr == nil {
		return errors.New("node manager is not running")
	}
	remote, err := mgr.RemoteFor(node)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	return remote.RestartXray(ctx)
}

func inboundNode(ib *model.Inbound) int {
	if ib == nil || ib.NodeID == nil {
		return 0
	}
	return *ib.NodeID
}
