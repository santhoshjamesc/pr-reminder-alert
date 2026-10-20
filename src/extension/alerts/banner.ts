import * as vscode from 'vscode';

/**
 * A prominent in-editor banner rendered as a decoration on the first visible
 * line of every visible editor. It never takes focus or edits the document.
 */
export class EditorBanner implements vscode.Disposable {
  private readonly bright: vscode.TextEditorDecorationType;
  private readonly dim: vscode.TextEditorDecorationType;
  private text: string | null = null;
  private flashTimer: NodeJS.Timeout | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private phase = true;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    const base = {
      isWholeLine: true,
      overviewRulerLane: vscode.OverviewRulerLane.Full,
      overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
    };
    this.bright = vscode.window.createTextEditorDecorationType({
      ...base,
      backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
      border: '2px solid',
      borderColor: new vscode.ThemeColor('editorError.foreground'),
    });
    this.dim = vscode.window.createTextEditorDecorationType({
      ...base,
      backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
      border: '2px dashed',
      borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    });
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.render()),
    );
  }

  show(text: string, options: { flash: boolean; hideAfterMs: number }): void {
    this.text = text;
    this.clearTimers();
    if (options.flash) {
      let flips = 0;
      this.flashTimer = setInterval(() => {
        this.phase = !this.phase;
        this.render();
        if (++flips >= 10) {
          this.clearFlash();
        }
      }, 600);
    }
    if (options.hideAfterMs > 0) {
      this.hideTimer = setTimeout(() => this.hide(), options.hideAfterMs);
    }
    this.render();
  }

  hide(): void {
    this.text = null;
    this.clearTimers();
    this.render();
  }

  get visible(): boolean {
    return this.text !== null;
  }

  private clearFlash(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    this.phase = true;
    this.render();
  }

  private clearTimers(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.phase = true;
  }

  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.bright, []);
      editor.setDecorations(this.dim, []);
      if (!this.text) {
        continue;
      }
      const line = editor.visibleRanges[0]?.start.line ?? 0;
      const range = new vscode.Range(line, 0, line, 0);
      const decoration: vscode.DecorationOptions = {
        range,
        hoverMessage: new vscode.MarkdownString().appendText(this.text),
        renderOptions: {
          after: {
            contentText: `  🔔 ${this.text}  `,
            color: new vscode.ThemeColor('editor.foreground'),
            backgroundColor: new vscode.ThemeColor(this.phase ? 'inputValidation.errorBackground' : 'inputValidation.warningBackground'),
            fontWeight: 'bold',
            margin: '0 0 0 3ch',
            border: '1px solid',
          },
        },
      };
      editor.setDecorations(this.phase ? this.bright : this.dim, [decoration]);
    }
  }

  dispose(): void {
    this.clearTimers();
    this.bright.dispose();
    this.dim.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}
