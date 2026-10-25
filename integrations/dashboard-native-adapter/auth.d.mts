interface TerminalRequest { headers: { authorization?: string; origin?: string; cookie?: string } }
export function createTerminalAuth(file: string | undefined, origin: string, required?: boolean): {
  originAllowed(request: TerminalRequest): boolean;
  authenticate(request: TerminalRequest): boolean;
  cookie: string;
} | null;
export function loadTerminalAuth(configFile: string | undefined, required?: boolean): ReturnType<typeof createTerminalAuth>;
