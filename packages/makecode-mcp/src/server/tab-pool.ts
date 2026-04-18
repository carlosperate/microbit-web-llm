import type { MakeCodeDriver } from "../browser/driver-port.js";

export interface TabHandle {
  driver: MakeCodeDriver;
  close(): Promise<void>;
}

export interface TabPool {
  openTab(): Promise<TabHandle>;
  withTransientTab<T>(fn: (driver: MakeCodeDriver) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
