package fr.nayz.endercloud.core.model;

public record ProxyControl(
        LifecycleState lifecycleState,
        boolean acceptingConnections,
        long controlLeaseMs
) {
}
