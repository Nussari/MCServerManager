const AdmZip = require('adm-zip');

/**
 * Detect the minimum Java version required by a JAR file.
 * Reads the class file version of the Main-Class from the JAR's manifest.
 * Returns the Java version (e.g. 21, 25) or null if detection fails.
 */
function detectJavaVersion(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const manifest = zip.getEntry('META-INF/MANIFEST.MF');
    if (!manifest) return null;

    const content = manifest.getData().toString('utf-8');
    const match = content.match(/^Main-Class:\s*(.+)/m);
    if (!match) return null;

    const classPath = match[1].trim().replace(/\./g, '/') + '.class';
    const classEntry = zip.getEntry(classPath);
    if (!classEntry) return null;

    const data = classEntry.getData();
    if (data.length < 8 || data.readUInt32BE(0) !== 0xCAFEBABE) return null;

    // Class file major version: 65 = Java 21, 66 = Java 22, ..., 69 = Java 25
    return data.readUInt16BE(6) - 44;
  } catch {
    return null;
  }
}

module.exports = { detectJavaVersion };
