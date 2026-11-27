import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { applySuggestedTagToContent, findTagMetadata } from "@/lib/tag";
import {
  InstanceSetting_TagMetadataSchema,
  InstanceSetting_TagsSettingSchema,
} from "@/types/proto/api/v1/instance_service_pb";
import { ColorSchema } from "@/types/proto/google/type/color_pb";

const makeColor = (r: number, g: number, b: number) =>
  create(ColorSchema, { red: r / 255, green: g / 255, blue: b / 255 });

describe("findTagMetadata secondary tag color inheritance", () => {
  it("inherits primary tag backgroundColor for secondary tags without inheriting blurContent", () => {
    const tagsSetting = create(InstanceSetting_TagsSettingSchema, {
      tags: {
        "^(技术|项目|工作|财务)$": create(InstanceSetting_TagMetadataSchema, {
          backgroundColor: makeColor(0x00, 0xcc, 0x66),
          blurContent: false,
        }),
        "^(日常|灵感|资料)$": create(InstanceSetting_TagMetadataSchema, {
          backgroundColor: makeColor(0x00, 0x80, 0xff),
          blurContent: true,
        }),
        "技术/秘密": create(InstanceSetting_TagMetadataSchema, {
          blurContent: true,
        }),
        "技术/自定义": create(InstanceSetting_TagMetadataSchema, {
          backgroundColor: makeColor(0xff, 0x00, 0x00),
          blurContent: false,
        }),
      },
    });

    const inherited = findTagMetadata("技术/Cloudflare", tagsSetting);
    expect(inherited?.backgroundColor?.green).toBeCloseTo(0xcc / 255);
    expect(inherited?.blurContent).toBe(false);

    // Must NOT inherit blurContent from parent rule
    const dailySub = findTagMetadata("日常/购物", tagsSetting);
    expect(dailySub?.backgroundColor?.blue).toBeCloseTo(1);
    expect(dailySub?.blurContent).toBe(false);

    // Own color takes priority
    const ownColor = findTagMetadata("技术/自定义", tagsSetting);
    expect(ownColor?.backgroundColor?.red).toBeCloseTo(1);
    expect(ownColor?.blurContent).toBe(false);

    // Own blurContent preserved while still inheriting missing backgroundColor
    const ownBlur = findTagMetadata("技术/秘密", tagsSetting);
    expect(ownBlur?.blurContent).toBe(true);
    expect(ownBlur?.backgroundColor?.green).toBeCloseTo(0xcc / 255);
  });
});

describe("applySuggestedTagToContent", () => {
  it("upgrades standalone primary tag to secondary tag safely without modifying code blocks or URLs", () => {
    const input = [
      "#技术 研究 Cloudflare Workers",
      "`#技术`",
      "https://example.com/docs#技术",
      "```bash",
      "#技术",
      "```",
    ].join("\n");

    const updated = applySuggestedTagToContent(input, "技术/Cloudflare");
    expect(updated).toBe(
      [
        "#技术/Cloudflare 研究 Cloudflare Workers",
        "`#技术`",
        "https://example.com/docs#技术",
        "```bash",
        "#技术",
        "```",
      ].join("\n"),
    );
  });

  it("does not upgrade an unrelated existing secondary tag and appends when standalone primary is absent", () => {
    const input = "#技术/AI工具 部署在边缘节点";
    expect(applySuggestedTagToContent(input, "技术/Cloudflare")).toBe("#技术/AI工具 部署在边缘节点 #技术/Cloudflare ");
  });

  it("skips duplicate insertion case-insensitively", () => {
    const input = "#技术/Cloudflare 部署说明";
    expect(applySuggestedTagToContent(input, "技术/cloudflare")).toBe(input);
  });
});
