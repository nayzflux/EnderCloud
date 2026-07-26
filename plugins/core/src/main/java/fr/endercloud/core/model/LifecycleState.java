package fr.endercloud.core.model;

public enum LifecycleState {
    CREATING,
    STARTING,
    RUNNING,
    DRAINING,
    STOPPING,
    STOPPED,
    FAILED,
    ORPHANED
}
