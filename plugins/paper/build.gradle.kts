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
    compileOnly(libs.paper.api)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.processResources {
    inputs.property("version", project.version)
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}

tasks.shadowJar {
    archiveBaseName.set("EnderCloudPaper")
    archiveClassifier = ""
    relocate("com.fasterxml.jackson", "fr.endercloud.libs.jackson")
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["shadow"])
            groupId = "fr.nayz.endercloud"
            artifactId = "paper"
        }
    }
}

tasks.build {
    dependsOn(tasks.publishToMavenLocal)
}
