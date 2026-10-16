package fr.nayz.endercloud.velocity;

import fr.nayz.endercloud.core.model.LifecycleState;
import fr.nayz.endercloud.core.model.ProxyControl;
import org.junit.jupiter.api.Test;

import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProxyAdmissionTest {
    @Test
    void startsClosedAndExpiresPermissionWhenControlIsLost() {
        ProxyAdmission admission = new ProxyAdmission();
        assertFalse(admission.allows(0));
        admission.apply(new ProxyControl(LifecycleState.RUNNING, true, 30_000), 0);
        assertTrue(admission.allows(TimeUnit.SECONDS.toNanos(29)));
        assertFalse(admission.allows(TimeUnit.SECONDS.toNanos(30)));
    }

    @Test
    void drainCannotBeReopenedByAnObsoleteRunningResponse() {
        ProxyAdmission admission = new ProxyAdmission();
        admission.apply(new ProxyControl(LifecycleState.RUNNING, true, 30_000), 0);
        admission.apply(new ProxyControl(LifecycleState.DRAINING, false, 30_000), 1);
        admission.apply(new ProxyControl(LifecycleState.RUNNING, true, 30_000), 2);
        assertFalse(admission.allows(3));
    }

    @Test
    void temporarilyUnreadyProxyCanRecoverBeforeDrain() {
        ProxyAdmission admission = new ProxyAdmission();
        admission.apply(new ProxyControl(LifecycleState.RUNNING, false, 30_000), 0);
        assertFalse(admission.allows(1));
        admission.apply(new ProxyControl(LifecycleState.RUNNING, true, 30_000), 2);
        assertTrue(admission.allows(3));
    }
}
