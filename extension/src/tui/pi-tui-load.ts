/**
 * Resolve `@earendil-works/pi-tui` from the host pi install.
 * Typed structurally so this package does not depend on pi-tui's declarations.
 */
import { createRequire } from "node:module";

export interface PiTuiText {
  setText(text: string): void;
  invalidate(): void;
}

export interface PiTuiScroll {
  viewportHeight: number;
  scrollBy(lines: number): number;
  scrollToEnd(): void;
  invalidate(): void;
}

export interface PiTuiComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface PiTuiModule {
  Text: new (text?: string, paddingX?: number, paddingY?: number) => PiTuiText & PiTuiComponent;
  ScrollView: new (
    component: PiTuiComponent,
    options?: {
      primary?: boolean;
      scrollbar?: "hidden" | "auto" | "always";
      follow?: "none" | "end";
      overscroll?: "chain" | "contain";
    },
  ) => PiTuiScroll & PiTuiComponent;
  VStack: new (
    children?: Array<
      | PiTuiComponent
      | {
          component: PiTuiComponent;
          basis?: number | "auto";
          grow?: number;
          shrink?: number;
          minSize?: number;
        }
    >,
    options?: { gap?: number },
  ) => PiTuiComponent;
  matchesKey(data: string, key: string): boolean;
  Box: new (
    paddingX?: number,
    paddingY?: number,
    bgFn?: (text: string) => string,
  ) => { addChild(component: unknown): void };
}

export function loadPiTui(): PiTuiModule | null {
  try {
    const require = createRequire(import.meta.url);
    try {
      return require("@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui") as PiTuiModule;
    } catch {
      return require("@earendil-works/pi-tui") as PiTuiModule;
    }
  } catch {
    return null;
  }
}
