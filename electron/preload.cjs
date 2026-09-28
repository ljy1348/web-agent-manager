const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("webAgentManagerSetup", {
  createAdmin: (username, password) => ipcRenderer.invoke("web-agent-manager:create-admin", { username, password }),
});

// 중계 모드 연결 화면(#139)과 시작 방식 선택 화면(#156)이 쓰는 브리지. 검증·저장은 메인 프로세스가 한다.
contextBridge.exposeInMainWorld("webAgentManagerDesktop", {
  connect: (serverUrl) => ipcRenderer.invoke("web-agent-manager:connect-server", serverUrl),
  inspectServerUrl: (serverUrl) => ipcRenderer.invoke("web-agent-manager:inspect-server-url", serverUrl),
  localDefaults: () => ipcRenderer.invoke("web-agent-manager:local-defaults"),
  chooseLocal: (settings) => ipcRenderer.invoke("web-agent-manager:choose-local", settings),
  chooseRemote: () => ipcRenderer.invoke("web-agent-manager:choose-remote"),
});
