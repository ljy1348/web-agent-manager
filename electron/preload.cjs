const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("webAgentManagerSetup", {
  createAdmin: (username, password) => ipcRenderer.invoke("web-agent-manager:create-admin", { username, password }),
});
