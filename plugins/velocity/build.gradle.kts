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
    testImplementation(libs.velocity.api)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.shadowJar {
    archiveBaseName.set("EnderCloudVelocity")
    archiveClassifier = ""
    relocate("com.fasterxml.jackson", "fr.endercloud.libs.jackson")
    relocate("io.lettuce", "fr.endercloud.libs.lettuce")
    relocate("reactor", "fr.endercloud.libs.reactor")
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
