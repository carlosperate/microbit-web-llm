export interface MakeCodeProjectFiles {
  text: Record<string, string>;
}

export interface MakeCodeDriver {
  getProject(): Promise<MakeCodeProjectFiles>;
  setProject(project: MakeCodeProjectFiles): Promise<void>;
  compile(): Promise<{ name: string; hex: string }>;
  renderBlocksImage(code: string): Promise<string>;
}
