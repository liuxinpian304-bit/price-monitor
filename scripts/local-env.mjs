const masterKeyPattern = /^SETTINGS_MASTER_KEY=[^\r\n]*/m;

export function commandSpawnOptions(platform = process.platform) {
  return {
    encoding: "utf8",
    shell: platform === "win32",
    windowsHide: true
  };
}

export function createLocalEnv(template, masterKey) {
  return template.replace(masterKeyPattern, `SETTINGS_MASTER_KEY=${masterKey}`);
}

export function checkNodeVersion(version, minimumMajor = 22) {
  const match = /^v?(\d+)/.exec(version);

  if (!match) {
    return {
      ok: false,
      message: `Unable to determine the Node.js version from ${JSON.stringify(version)}. Node.js ${minimumMajor} or newer is required.`,
    };
  }

  const major = Number(match[1]);
  const ok = major >= minimumMajor;

  return {
    ok,
    message: ok
      ? `Node.js ${version} meets the required version (${minimumMajor}+).`
      : `Node.js ${version} is unsupported. Node.js ${minimumMajor} or newer is required.`,
  };
}
