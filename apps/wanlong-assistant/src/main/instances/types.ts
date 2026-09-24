/**
 * Base-instance contracts shared by main, preload and renderer. Types only: the renderer imports this file, so
 * it must never import runtime code.
 */
import type { InstanceStatus } from '@avdm/core';

/** The instance new copies are cloned from. `createdAt` is the AVD's creation identity (index alone is reused). */
export interface BaseInstanceSelection {
  index: number;
  name: string;
  createdAt: string;
  setAt: number;
}

export interface BaseInstanceView {
  gameId: string;
  base: BaseInstanceSelection | null;
  /** Current state of the base AVD; null without a base. */
  status: InstanceStatus | null;
  /** Why cloning is not possible right now (running, busy, still provisioning), or null. */
  cloneBlocked: string | null;
  /** Set once when a stored base was cleared because its AVD was deleted or replaced. */
  cleared?: { index: number; name: string; reason: string };
}

export interface CloneFromBaseRequest {
  /** 1–8 copies, all from the same stopped base. */
  count: number;
  /** The base index the user saw when opening the dialog; a changed base is refused. */
  expectedBaseIndex: number;
  /**
   * Default true: every copy gets new random device identifiers (serial, MAC, Android ID), so the game treats it
   * as a new device and the login wizard follows. False keeps the emulator default, which may carry over the
   * source's login state.
   */
  rotateIdentity?: boolean;
}

export interface CloneFromBaseResult {
  baseIndex: number;
  created: Array<{ index: number; name: string }>;
  /** Non-fatal follow-ups, e.g. a copy that could not inherit the base's template set. */
  warnings: string[];
}

export interface InstanceBaseChangedEvent {
  gameId: string;
  view: BaseInstanceView;
}
