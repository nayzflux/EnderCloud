package fr.nayz.endercloud.velocity;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class EndpointTest {
    @Test
    void parsesDockerDnsEndpoints() {
        var address = EnderCloudVelocityPlugin.parseEndpoint("endercloud-instance:25565");
        assertEquals("endercloud-instance", address.getHostString());
        assertEquals(25565, address.getPort());
    }

    @Test
    void rejectsMissingPorts() {
        assertThrows(
                IllegalArgumentException.class,
                () -> EnderCloudVelocityPlugin.parseEndpoint("endercloud-instance")
        );
    }
}
