package fr.nayz.endercloud.core.model;

import java.util.List;

public record RegistrySnapshot(long revision, List<ServerSnapshot> servers) {
    public RegistrySnapshot { servers = List.copyOf(servers); }
}
