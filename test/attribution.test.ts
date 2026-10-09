import { describe, expect, it } from "vitest";
import { attributeOrder } from "../src/domain/attribution.ts";
import { memoryDirectory } from "./helpers.ts";

const directory = memoryDirectory(
  { ANA10: "cr_ana", BIA15: "cr_bia", BIAVIP: "cr_bia", CAIO20: "cr_caio" },
  { ana: "cr_ana", bia: "cr_bia", caio: "cr_caio" },
);

const codes = (...list: string[]) => list.map((code) => ({ code }));

describe("attributeOrder", () => {
  it("attributes by creator coupon", () => {
    const result = attributeOrder({ discount_codes: codes("ANA10") }, directory);
    expect(result).toMatchObject({ creator_id: "cr_ana", rule: "coupon", conflicts: [] });
    expect(result.evidence.coupons).toEqual([{ code: "ANA10", creator_id: "cr_ana" }]);
  });

  it("attributes by utm_content when there is no coupon", () => {
    const result = attributeOrder({ landing_site: "/?utm_source=conty&utm_campaign=verao&utm_content=bia" }, directory);
    expect(result).toMatchObject({ creator_id: "cr_bia", rule: "utm", conflicts: [] });
    expect(result.evidence.utm).toEqual({ source: "conty", campaign: "verao", content: "bia" });
  });

  describe("tie-break: coupon and UTM point to different creators", () => {
    const result = attributeOrder(
      { discount_codes: codes("ANA10"), landing_site: "/?utm_content=bia" },
      directory,
    );

    it("coupon wins over UTM", () => {
      expect(result.creator_id).toBe("cr_ana");
      expect(result.rule).toBe("coupon");
    });

    it("lists both creators as conflicts, winner first", () => {
      expect(result.conflicts).toEqual([
        { source: "coupon", value: "ANA10", creator_id: "cr_ana" },
        { source: "utm_content", value: "bia", creator_id: "cr_bia" },
      ]);
    });
  });

  it("is not a conflict when coupon and UTM name the same creator", () => {
    const result = attributeOrder({ discount_codes: codes("ANA10"), landing_site: "/?utm_content=ana" }, directory);
    expect(result).toMatchObject({ creator_id: "cr_ana", rule: "coupon", conflicts: [] });
    expect(result.evidence.candidates).toHaveLength(2);
  });

  it("ignores an unknown coupon but keeps it as evidence, then falls back to UTM", () => {
    const result = attributeOrder({ discount_codes: codes("BLACKFRIDAY"), landing_site: "/?utm_content=caio" }, directory);
    expect(result).toMatchObject({ creator_id: "cr_caio", rule: "utm", conflicts: [] });
    expect(result.evidence.coupons).toEqual([{ code: "BLACKFRIDAY", creator_id: null }]);
  });

  it("is unattributed without any signal", () => {
    expect(attributeOrder({}, directory)).toMatchObject({ creator_id: null, rule: "none", conflicts: [] });
    expect(attributeOrder({ discount_codes: [], landing_site: "/" }, directory)).toMatchObject({ creator_id: null, rule: "none" });
  });

  it("is unattributed when the UTM handle is not a known creator", () => {
    const result = attributeOrder({ landing_site: "/?utm_source=newsletter&utm_content=header" }, directory);
    expect(result.creator_id).toBeNull();
    expect(result.evidence.utm.source).toBe("newsletter");
  });

  it("matches coupons and handles ignoring case and spaces", () => {
    expect(attributeOrder({ discount_codes: codes(" ana10 ") }, directory).creator_id).toBe("cr_ana");
    expect(attributeOrder({ landing_site: "/?utm_content=%20BIA" }, directory).creator_id).toBe("cr_bia");
  });

  it("reads absolute landing_site URLs", () => {
    const result = attributeOrder({ landing_site: "https://loja.com.br/products/x?utm_content=caio#top" }, directory);
    expect(result.creator_id).toBe("cr_caio");
  });

  it("falls back to utm_source when utm_content is not a creator", () => {
    const result = attributeOrder({ landing_site: "/?utm_source=ana&utm_content=banner" }, directory);
    expect(result).toMatchObject({ creator_id: "cr_ana", rule: "utm" });
  });

  it("prefers utm_content over utm_source and records the disagreement", () => {
    const result = attributeOrder({ landing_site: "/?utm_source=ana&utm_content=bia" }, directory);
    expect(result.creator_id).toBe("cr_bia");
    expect(result.conflicts.map((c) => c.creator_id)).toEqual(["cr_bia", "cr_ana"]);
  });

  it("uses the first coupon in order when two coupons belong to different creators", () => {
    const result = attributeOrder({ discount_codes: codes("CAIO20", "ANA10") }, directory);
    expect(result.creator_id).toBe("cr_caio");
    expect(result.conflicts).toHaveLength(2);
  });

  it("does not conflict when two coupons belong to the same creator", () => {
    const result = attributeOrder({ discount_codes: codes("BIA15", "BIAVIP") }, directory);
    expect(result).toMatchObject({ creator_id: "cr_bia", conflicts: [] });
  });

  it("reads UTMs from note_attributes only for keys landing_site left empty", () => {
    const result = attributeOrder(
      {
        landing_site: "/?utm_source=conty",
        note_attributes: [
          { name: "utm_content", value: "caio" },
          { name: "utm_source", value: "ana" },
        ],
      },
      directory,
    );
    expect(result.creator_id).toBe("cr_caio");
    expect(result.evidence.utm.source).toBe("conty");
    expect(result.conflicts).toEqual([]);
  });

  it("survives junk input", () => {
    const result = attributeOrder(
      { discount_codes: [{ code: 5 }, {}, { code: "  " }, null as never], landing_site: "http://", note_attributes: [{ name: 1, value: 2 }] },
      directory,
    );
    expect(result).toMatchObject({ creator_id: null, rule: "none" });
  });
});
