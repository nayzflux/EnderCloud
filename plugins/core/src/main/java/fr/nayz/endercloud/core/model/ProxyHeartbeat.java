package fr.nayz.endercloud.core.model;

public record ProxyHeartbeat(
        boolean ready,
        int playerCount,
        boolean acceptingConnections
) {
}
