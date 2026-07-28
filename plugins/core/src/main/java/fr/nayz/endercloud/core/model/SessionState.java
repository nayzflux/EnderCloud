package fr.nayz.endercloud.core.model;

public enum SessionState {
    FORMING,
    WAITING_FOR_INSTANCE,
    TRANSFERRING,
    WAITING,
    STARTING,
    RUNNING,
    FINISHED,
    CANCELLED,
    FAILED
}
