package fr.nayz.endercloud.velocity;

import fr.nayz.endercloud.core.model.AvailabilityState;
import fr.nayz.endercloud.core.model.LifecycleState;
import fr.nayz.endercloud.core.model.ServerSnapshot;
import org.junit.jupiter.api.Test;

import java.net.SocketAddress;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class RegistryReconciliationTest {

    @Test
    void removesAStaleServerAfterItsUnregistrationEventWasLost() {
        ServerSnapshot retained = server("retained", "host-one:25565");
        Map<String, SocketAddress> registered = Map.of(
                RegistryReconciliation.serverName(retained),
                EnderCloudVelocityPlugin.parseEndpoint(retained.endpoint()),
                "ec-variant-removed",
                EnderCloudVelocityPlugin.parseEndpoint("host-two:25565")
        );

        RegistryReconciliation.Changes changes = RegistryReconciliation.plan(
                List.of(retained),
                registered
        );

        assertEquals(List.of("ec-variant-removed"), changes.unregister());
        assertEquals(List.of(), changes.register());
    }

    @Test
    void replacesOnlyAnEndpointThatChanged() {
        ServerSnapshot retained = server("retained", "host-one:25565");
        ServerSnapshot changed = server("changed", "host-new:25565");
        Map<String, SocketAddress> registered = Map.of(
                RegistryReconciliation.serverName(retained),
                EnderCloudVelocityPlugin.parseEndpoint(retained.endpoint()),
                RegistryReconciliation.serverName(changed),
                EnderCloudVelocityPlugin.parseEndpoint("host-old:25565")
        );

        RegistryReconciliation.Changes changes = RegistryReconciliation.plan(
                List.of(retained, changed),
                registered
        );

        assertEquals(List.of(RegistryReconciliation.serverName(changed)), changes.unregister());
        assertEquals(List.of(changed), changes.register());
    }

    private static ServerSnapshot server(String instanceId, String endpoint) {
        return new ServerSnapshot(
                instanceId,
                "variant",
                "group",
                "hub",
                endpoint,
                LifecycleState.RUNNING,
                AvailabilityState.OPEN,
                0,
                100
        );
    }
}
