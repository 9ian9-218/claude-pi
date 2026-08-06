import { describe, it } from "vitest";
import { TuiApp } from "../src/tui/app.ts";
import type { Terminal } from "@earendil-works/pi-tui";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  get columns(): number { return 80; }
  get rows(): number { return 24; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  onInput?: (data: string) => void;
}

describe("ac-debug3", () => {
  it("typing via editor.handleInput inside TuiApp", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    app.editor.handleInput("/");
    app.editor.handleInput("h");
    console.log("TEXT:", JSON.stringify(app.editor.getText()));
    const editor = app.editor as unknown as { autocompleteState: unknown };
    console.log("AC STATE:", editor.autocompleteState);
    await new Promise((r) => setTimeout(r, 500));
    const rendered = app.editor.render(80);
    console.log("HAS help:", rendered.join("\n").includes("help"));
    app.stop();
  });
});
