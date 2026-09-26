import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ContextStatus {
  context: number;
  contextFormatted: string;
  turns: number;
  model: string;
  emoji: string;
  recommendation: string;
  timestamp: string;
  thresholdPercent: number;
  loopThresholdPercent: number;
  atThreshold: boolean;
  atLoopThreshold: boolean;
}

let statusBar: vscode.StatusBarItem;
let monitorFile: string;
let fileWatcher: fs.FSWatcher | null = null;

export function activate(context: vscode.ExtensionContext) {
  monitorFile = path.join(os.homedir(), '.claude', 'context-monitor.json');

  // 상태 표시줄 생성
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'token-router.showPanel';
  context.subscriptions.push(statusBar);

  // 패널 표시 커맨드
  const showPanelCmd = vscode.commands.registerCommand('token-router.showPanel', () => {
    vscode.commands.executeCommand('token-router-container.focus');
  });
  context.subscriptions.push(showPanelCmd);

  // 초기 상태 업데이트
  updateStatus();

  // 파일 변경 감시
  watchMonitorFile(context);

  // 5초마다 체크 (파일 이벤트 누락 대비)
  const interval = setInterval(() => {
    updateStatus();
  }, 5000);

  context.subscriptions.push({
    dispose: () => clearInterval(interval)
  });
}

function watchMonitorFile(context: vscode.ExtensionContext) {
  if (fileWatcher) {
    fileWatcher.close();
  }

  const dir = path.dirname(monitorFile);
  try {
    fileWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === 'context-monitor.json') {
        // 파일이 쓰여지는 중일 수 있으니 약간의 지연
        setTimeout(() => updateStatus(), 100);
      }
    });
  } catch (e) {
    // 폴더가 없으면 무시
  }
}

function updateStatus() {
  try {
    if (!fs.existsSync(monitorFile)) {
      statusBar.text = '$(loading~spin) Token Router';
      statusBar.show();
      return;
    }

    const data = fs.readFileSync(monitorFile, 'utf-8');
    const status: ContextStatus = JSON.parse(data);

    // 상태 표시줄에 표시
    const icon = getIconForEmoji(status.emoji);
    statusBar.text = `${icon} ${status.contextFormatted} (${status.thresholdPercent}%)`;
    statusBar.tooltip = `Model: ${status.model}\nRecommendation: ${status.recommendation}`;

    // 색상 변경
    updateStatusBarColor(status.emoji);

    statusBar.show();
  } catch (e) {
    statusBar.text = '$(error) Token Router';
    statusBar.show();
  }
}

function getIconForEmoji(emoji: string): string {
  switch (emoji) {
    case '🟢': return '$(circle-filled)';
    case '🟡': return '$(circle-filled)';
    case '🟠': return '$(circle-filled)';
    case '🔴': return '$(circle-filled)';
    default: return '$(loading~spin)';
  }
}

function updateStatusBarColor(emoji: string) {
  const colors: { [key: string]: string } = {
    '🟢': '#22c55e',  // green
    '🟡': '#eab308',  // yellow
    '🟠': '#f97316',  // orange
    '🔴': '#ef4444'   // red
  };

  const color = colors[emoji];
  if (color) {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBar.background');
    // VSCode API의 제약으로 직접 색 변경이 어렵지만, 텍스트 색상 변경으로 표현
    statusBar.color = color;
  }
}

export function deactivate() {
  if (fileWatcher) {
    fileWatcher.close();
  }
}
