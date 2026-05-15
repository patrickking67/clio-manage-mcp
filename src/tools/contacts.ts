import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { defineTool, paginationShape, type ToolContext } from "./_base.js";

const DEFAULT_CONTACT_FIELDS =
  "id,name,first_name,last_name,type,company,primary_email_address,primary_phone_number," +
  "email_addresses{address,name,default_email},phone_numbers{number,name,default_number}," +
  "addresses{street,city,province,postal_code,country,name}";

const ALLOWED_ADDRESS_NAMES = new Set(["Work", "Home", "Billing", "Other"]);

function normalizeAddressName(name: string | undefined): string {
  if (!name) return "Work";
  const titled = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return ALLOWED_ADDRESS_NAMES.has(titled) ? titled : "Work";
}

const addressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  name: z.string().optional().describe('One of: "Work", "Home", "Billing", "Other". Coerced if invalid.'),
});

const emailSchema = z.object({
  address: z.string().email(),
  name: z.string().optional(),
  default_email: z.boolean().optional(),
});

const phoneSchema = z.object({
  number: z.string(),
  name: z.string().optional(),
  default_number: z.boolean().optional(),
});

export function registerContactTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: "clio_search_contacts",
    title: "Search contacts",
    description:
      "Search contacts by free-text query (matches name, email, company). Use clio_get_contact for full detail.",
    inputSchema: {
      query: z.string().describe("Search term — name, email, company, phone."),
      type: z.enum(["Person", "Company"]).optional(),
      ...paginationShape,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      const items = await c.client.paginate<unknown>("contacts.json", {
        query: { query: args.query, type: args.type },
        fields: DEFAULT_CONTACT_FIELDS,
        limit: args.limit,
        pageSize: args.page_size,
      });
      return { data: items, count: items.length };
    },
  });

  defineTool(server, ctx, {
    name: "clio_get_contact",
    title: "Get contact",
    description: "Returns full detail for a contact, including all emails, phone numbers, and addresses.",
    inputSchema: {
      contact_id: z.number().int(),
      fields: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler(args, c) {
      return c.client.request(`/contacts/${args.contact_id}.json`, {
        fields: args.fields ?? DEFAULT_CONTACT_FIELDS + ",date_created,date_updated",
      });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_person_contact",
    title: "Create person contact",
    description: "Creates a person (individual) contact in Clio.",
    inputSchema: {
      first_name: z.string(),
      last_name: z.string(),
      middle_name: z.string().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      title: z.string().optional(),
      company_id: z.number().int().optional().describe("Link this person to a company contact."),
      email_addresses: z.array(emailSchema).optional(),
      phone_numbers: z.array(phoneSchema).optional(),
      addresses: z.array(addressSchema).optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const data: Record<string, unknown> = {
        type: "Person",
        first_name: args.first_name,
        last_name: args.last_name,
        middle_name: args.middle_name,
        prefix: args.prefix,
        suffix: args.suffix,
        title: args.title,
      };
      if (args.company_id) data.company = { id: args.company_id };
      if (args.email_addresses) data.email_addresses = args.email_addresses;
      if (args.phone_numbers) data.phone_numbers = args.phone_numbers;
      if (args.addresses) {
        data.addresses = args.addresses.map((a) => ({ ...a, name: normalizeAddressName(a.name) }));
      }
      return c.client.request("/contacts.json", { method: "POST", data });
    },
  });

  defineTool(server, ctx, {
    name: "clio_create_company_contact",
    title: "Create company contact",
    description: "Creates a company (entity) contact in Clio — Inc., LLC, Ltd., etc.",
    inputSchema: {
      name: z.string().describe("Company legal name."),
      email_addresses: z.array(emailSchema).optional(),
      phone_numbers: z.array(phoneSchema).optional(),
      addresses: z.array(addressSchema).optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const data: Record<string, unknown> = { type: "Company", name: args.name };
      if (args.email_addresses) data.email_addresses = args.email_addresses;
      if (args.phone_numbers) data.phone_numbers = args.phone_numbers;
      if (args.addresses) {
        data.addresses = args.addresses.map((a) => ({ ...a, name: normalizeAddressName(a.name) }));
      }
      return c.client.request("/contacts.json", { method: "POST", data });
    },
  });

  defineTool(server, ctx, {
    name: "clio_update_contact",
    title: "Update contact",
    description: "PATCH a contact. Pass only the fields you want to change.",
    inputSchema: {
      contact_id: z.number().int(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      name: z.string().optional().describe("Company name (Company-type contacts)."),
      title: z.string().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    async handler(args, c) {
      const { contact_id, ...rest } = args;
      return c.client.request(`/contacts/${contact_id}.json`, { method: "PATCH", data: rest });
    },
  });

  defineTool(server, ctx, {
    name: "clio_delete_contact",
    title: "Delete contact",
    description:
      "Deletes a contact. Disabled unless CLIO_ALLOW_DESTRUCTIVE=true. Returns 409 if the contact has " +
      "open bills, 422 if they are a client on an open matter.",
    inputSchema: { contact_id: z.number().int() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler(args, c) {
      if (!c.cfg.allowDestructive) {
        throw new Error("Destructive operations are disabled. Set CLIO_ALLOW_DESTRUCTIVE=true to enable.");
      }
      await c.client.request(`/contacts/${args.contact_id}.json`, { method: "DELETE" });
      return { ok: true, contact_id: args.contact_id };
    },
  });
}
