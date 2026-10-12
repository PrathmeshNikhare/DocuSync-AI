// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "./decision-panel";
import { LoginForm } from "./login-form";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PATCH = "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n";
const respond = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("DecisionPanel", () => {
  it("asks for confirmation, focuses it, and Escape cancels", () => {
    render(<DecisionPanel proposalId="p1" patch={PATCH} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
    const confirm = screen.getByRole("button", { name: "Confirm accept" });
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByText(/Nothing is written to GitHub/)).toBeTruthy();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Confirm accept" })).toBeNull();
    // Focus returns to the button that opened the step.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Accept…" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit patch…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit patch…" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only the decision, shows pending, then success and refreshes", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<DecisionPanel proposalId="p1" patch={PATCH} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    const pending = await screen.findByRole("button", { name: "Recording…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () =>
      resolve(new Response(JSON.stringify({ decision: {} }), { status: 200 })),
    );
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Decision recorded: rejected");
    // Focus moves to the confirmation instead of falling to the page body.
    expect(document.activeElement).toBe(notice.parentElement);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("edits the patch with a labelled, focused editor and reports validation issues", async () => {
    fetchMock.mockReturnValue(
      respond(422, {
        error: { code: "EDIT_INVALID", message: "x", requestId: "r" },
        issues: ["PATCH_NEW_URL"],
      }),
    );
    render(<DecisionPanel proposalId="p1" patch={PATCH} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit patch…" }));
    const editor = screen.getByLabelText(
      "Edited patch (unified diff)",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe(PATCH);
    fireEvent.change(editor, {
      target: { value: PATCH.replace("+new", "+https://evil.example") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edited patch" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("did not pass validation");
    expect(alert.textContent).toContain("PATCH_NEW_URL");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      decision: "edited",
      editedPatch: PATCH.replace("+new", "+https://evil.example"),
    });
    // Still editable: the reviewer can fix the patch and try again.
    expect(screen.getByLabelText("Edited patch (unified diff)")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [409, "INVALID_TRANSITION", "already has a decision"],
    [401, "UNAUTHENTICATED", "session has ended"],
    [409, "PROPOSAL_NOT_VALID", "did not pass validation"],
    [500, "SOMETHING_NEW", "Server said no"],
  ])("explains a %i %s response", async (status, code, text) => {
    fetchMock.mockReturnValue(
      respond(status, {
        error: { code, message: "Server said no", requestId: "r" },
      }),
    );
    render(<DecisionPanel proposalId="p1" patch={PATCH} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    expect((await screen.findByRole("alert")).textContent).toContain(text);
  });

  it("reports a network failure without claiming success", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    render(<DecisionPanel proposalId="p1" patch={PATCH} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Network error: the decision was not recorded",
    );
    expect(screen.queryByText(/Decision recorded/)).toBeNull();
  });
});

describe("LoginForm", () => {
  it("has labelled fields with the right autocomplete hints", () => {
    render(<LoginForm action={vi.fn(async () => ({}))} />);
    expect(screen.getByLabelText("Username").getAttribute("autocomplete")).toBe(
      "username",
    );
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
  });

  it("shows the server's error after a failed sign-in", async () => {
    const action = vi.fn(async () => ({
      error: "Incorrect username or password.",
    }));
    render(<LoginForm action={action} />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong password!!" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Incorrect username or password.",
      ),
    );
    expect(action).toHaveBeenCalledOnce();
    const form = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(form.get("username")).toBe("alice");
  });
});
