import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MyAccountSection from "@/components/Settings/MyAccountSection";
import { User_Role } from "@/types/proto/api/v1/user_service_pb";

let mockUser = {
  name: "users/alice",
  username: "alice",
  displayName: "Alice",
  description: "",
  avatarUrl: "",
  role: User_Role.USER,
};

vi.mock("@/hooks/useCurrentUser", () => ({
  default: () => mockUser,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    logout: vi.fn(),
  }),
}));

vi.mock("@/hooks/useNavigateTo", () => ({
  default: () => vi.fn(),
}));

vi.mock("@/utils/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/i18n")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => key,
  };
});

vi.mock("@/components/Settings/AccessTokenSection", () => ({
  default: () => <div data-testid="pat-section" />,
}));

vi.mock("@/components/Settings/LinkedIdentitySection", () => ({
  default: () => <div data-testid="linked-section" />,
}));

vi.mock("@/components/UpdateAccountDialog", () => ({
  default: () => null,
}));

vi.mock("@/components/ChangeMemberPasswordDialog", () => ({
  default: () => null,
}));

describe("MyAccountSection", () => {
  beforeEach(() => {
    mockUser = {
      name: "users/alice",
      username: "alice",
      displayName: "Alice",
      description: "",
      avatarUrl: "",
      role: User_Role.USER,
    };
  });

  it("hides account deletion danger area for non-admin users while keeping PAT section", () => {
    render(<MyAccountSection />);

    expect(screen.getByTestId("pat-section")).toBeInTheDocument();
    expect(screen.queryByText("setting.account.delete-account")).not.toBeInTheDocument();
  });

  it("shows account deletion danger area for admin users", () => {
    mockUser.role = User_Role.ADMIN;
    render(<MyAccountSection />);

    expect(screen.getByTestId("pat-section")).toBeInTheDocument();
    expect(screen.getAllByText("setting.account.delete-account").length).toBeGreaterThan(0);
  });
});
