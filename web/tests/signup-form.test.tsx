import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignUp from "@/pages/SignUp";

const createUserMock = vi.fn();
const signInMock = vi.fn();

vi.mock("@/connect", () => ({
  userServiceClient: {
    createUser: (...args: unknown[]) => createUserMock(...args),
  },
  authServiceClient: {
    signIn: (...args: unknown[]) => signInMock(...args),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({
    generalSetting: { disallowUserRegistration: false, disallowPasswordAuth: false },
    profile: {},
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/hooks/useNavigateTo", () => ({
  default: () => vi.fn(),
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string) => key,
}));

vi.mock("@/components/AuthFooter", () => ({
  default: () => null,
}));

vi.mock("react-hot-toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("SignUp", () => {
  beforeEach(() => {
    createUserMock.mockReset().mockResolvedValue({ name: "users/alice" });
    signInMock.mockReset().mockResolvedValue({ accessToken: "tok" });
  });

  it("submits registration only once when clicking the submit button", async () => {
    render(
      <MemoryRouter>
        <SignUp />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("common.username"), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText("common.password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "common.sign-up" }));

    await waitFor(() => {
      expect(createUserMock).toHaveBeenCalledTimes(1);
      expect(signInMock).toHaveBeenCalledTimes(1);
    });
  });
});
