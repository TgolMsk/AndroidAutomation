/** Props every page receives from the shell. */
export interface ViewProps {
  /** False while a kept-alive page is hidden behind another page (pause polling, keep drafts). */
  visible: boolean;
}
