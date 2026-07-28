package fr.nayz.endercloud.core.model;

public record ServerSnapshot(
        String instanceId,
        String variantId,
        String groupId,
        String groupType,
        String endpoint,
        LifecycleState lifecycleState,
        AvailabilityState availabilityState,
        int playerCount,
        int maximumPlayers
) {
    public boolean isHubTarget() {
        return "hub".equals(groupType)
                && lifecycleState == LifecycleState.RUNNING
                && availabilityState == AvailabilityState.OPEN
                && playerCount < maximumPlayers;
    }
}
