package fr.nayz.endercloud.velocity;

import fr.nayz.endercloud.core.model.LifecycleState;
import fr.nayz.endercloud.core.model.ProxyControl;

import java.util.concurrent.TimeUnit;

final class ProxyAdmission {
    private boolean permitted;
    private boolean draining;
    private long expiresAt;

    synchronized void apply(ProxyControl control, long now) {
        if (control.lifecycleState() == LifecycleState.DRAINING
                || control.lifecycleState() == LifecycleState.STOPPING
                || control.lifecycleState() == LifecycleState.STOPPED
                || control.lifecycleState() == LifecycleState.FAILED
                || control.lifecycleState() == LifecycleState.ORPHANED) {
            draining = true;
        }
        permitted = control.acceptingConnections()
                && control.lifecycleState() == LifecycleState.RUNNING
                && !draining;
        expiresAt = now + TimeUnit.MILLISECONDS.toNanos(control.controlLeaseMs());
    }

    synchronized boolean allows(long now) {
        return permitted && !draining && now - expiresAt < 0;
    }
}
