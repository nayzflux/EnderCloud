package fr.nayz.endercloud.velocity;

import fr.nayz.endercloud.core.model.ServerSnapshot;

import java.net.SocketAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

final class RegistryReconciliation {

    record Changes(List<String> unregister, List<ServerSnapshot> register) {
    }

    private RegistryReconciliation() {
    }

    static Changes plan(List<ServerSnapshot> servers, Map<String, SocketAddress> registered) {
        Map<String, ServerSnapshot> desired = new HashMap<>();
        for (ServerSnapshot server : servers) {
            if (server.endpoint() != null && !server.endpoint().isBlank()) {
                desired.put(serverName(server), server);
            }
        }

        List<String> unregister = new ArrayList<>();
        for (Map.Entry<String, SocketAddress> entry : registered.entrySet()) {
            String name = entry.getKey();
            if (!name.startsWith("ec-") && !name.startsWith("endercloud-")) {
                continue;
            }
            ServerSnapshot wanted = desired.get(name);
            if (wanted == null || !Objects.equals(
                    entry.getValue(),
                    EnderCloudVelocityPlugin.parseEndpoint(wanted.endpoint())
            )) {
                unregister.add(name);
            }
        }

        List<ServerSnapshot> register = new ArrayList<>();
        for (Map.Entry<String, ServerSnapshot> entry : desired.entrySet()) {
            SocketAddress actual = registered.get(entry.getKey());
            SocketAddress expected = EnderCloudVelocityPlugin.parseEndpoint(entry.getValue().endpoint());
            if (!Objects.equals(actual, expected)) {
                register.add(entry.getValue());
            }
        }
        return new Changes(unregister, register);
    }

    static String serverName(ServerSnapshot snapshot) {
        return "ec-" + snapshot.variantId() + "-" + snapshot.instanceId();
    }
}
