package fr.nayz.endercloud.core.http;

public final class EnderCloudException extends RuntimeException {
    private final int statusCode;

    public EnderCloudException(int statusCode, String message) {
        super(message);
        this.statusCode = statusCode;
    }

    public int statusCode() {
        return statusCode;
    }
}
