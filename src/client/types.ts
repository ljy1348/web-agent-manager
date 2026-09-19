export type Tab = "overview" | "tasks" | "chat" | "files" | "instructions" | "git" | "schedules" | "experiments" | "tools" | "settings";

export type Json = Record<string, any>;

export interface ApprovalAction {
  decision: string;
  label: string;
  className?: string;
}

export interface ChatActivity {
  label: string;
  className: string;
}

export interface ChatScrollState {
  userScrolled: boolean;
  prevChatId: number | null;
  prevFirstId: string | null;
  scrollTop: number;
}
