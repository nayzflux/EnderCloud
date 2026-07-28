plugins {
    java
    `maven-publish`
    alias(libs.plugins.shadow)
}

java {
    toolchain.languageVersion = JavaLanguageVersion.of(25)
}

dependencies {
    implementation(project(":core"))
    implementation(libs.lettuce)
    compileOnly(libs.velocity.api)
    annotationProcessor(libs.velocity.api)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.shadowJar {
    archiveBaseName.set("EnderCloudVelocity")
    archiveClassifier = ""
    relocate("com.fasterxml.jackson", "fr.endercloud.libs.jackson")
    relocate("io.lettuce", "fr.endercloud.libs.lettuce")
    relocate("reactor", "fr.endercloud.libs.reactor")
}

tasks.build {
    dependsOn(tasks.publishToMavenLocal)
    finalizedBy("copyJarToServer")
}

tasks {
    register("copyJarToServer", Copy::class) {
        from(shadowJar.get().archiveFile)
        into("${System.getenv("USERPROFILE")}/Documents/Minecraft/proxy/proxy/plugins")
    }
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["shadow"])
            groupId = "fr.nayz.endercloud"
            artifactId = "velocity"
        }
    }
}
