import type { ProcessorDatabase } from "../processor/processor.js";
import type { ApiDatabase, ListArcsParams, UpdateArcRequest, CreateViewRequest, UpdateViewRequest, CreateLabelRequest, UpdateLabelRequest, CreateRuleRequest, UpdateRuleRequest } from "../api/app.js";
import type { Arc, Signal, View, Label, Rule, Domain, Account, Page, PageParams, EmailAddressConfig } from "../types/index.js";
import type { AccountDatabase } from "./account-database.js";
import type { ArcDatabase } from "./arc-database.js";
import type { ProcessingDatabase } from "./processing-database.js";

// ---------------------------------------------------------------------------
// ProcessorDatabaseAdapter
// Wires AccountDatabase + ArcDatabase + ProcessingDatabase → ProcessorDatabase
// ---------------------------------------------------------------------------

export class ProcessorDatabaseAdapter implements ProcessorDatabase {
  constructor(
    private readonly arc: ArcDatabase,
    private readonly account: AccountDatabase,
    private readonly processing: ProcessingDatabase,
  ) {}

  getSignalByMessageId(accountId: string, sesMessageId: string) { return this.arc.getSignalByMessageId(accountId, sesMessageId); }
  saveSignal(signal: Signal) { return this.arc.saveSignal(signal); }
  getArc(accountId: string, id: string) { return this.arc.getArc(accountId, id); }
  findArcByGroupingKey(accountId: string, key: string) { return this.arc.findArcByGroupingKey(accountId, key); }
  saveArc(arc: Arc) { return this.arc.saveArc(arc); }
  listRules(accountId: string) { return this.account.listRules(accountId); }
  getEmailAddressConfig(accountId: string, address: string) { return this.account.getEmailAddressConfig(accountId, address); }
  saveEmailAddressConfig(config: EmailAddressConfig) { return this.account.saveEmailAddressConfig(config); }
  getAccountFilteringConfig(accountId: string) { return this.account.getAccountFilteringConfig(accountId); }
  getAccountRetentionDays(accountId: string) { return this.account.getAccountRetentionDays(accountId); }
  updateGlobalReputation(domain: string, update: { wasSpam: boolean; wasBlocked: boolean }) { return this.processing.updateGlobalReputation(domain, update); }
}

// ---------------------------------------------------------------------------
// ApiDatabaseAdapter
// Wires AccountDatabase + ArcDatabase → ApiDatabase
// ---------------------------------------------------------------------------

export class ApiDatabaseAdapter implements ApiDatabase {
  constructor(
    private readonly arc: ArcDatabase,
    private readonly account: AccountDatabase,
  ) {}

  // Arcs
  listArcs(accountId: string, params: ListArcsParams) { return this.arc.listArcs(accountId, params); }
  getArc(accountId: string, id: string) { return this.arc.getArc(accountId, id); }
  updateArc(accountId: string, id: string, update: UpdateArcRequest) { return this.arc.updateArc(accountId, id, update); }
  createArc(arc: Arc) { return this.arc.createArc(arc); }

  // Signals
  listSignals(accountId: string, arcId: string, params: PageParams) { return this.arc.listSignals(accountId, arcId, params); }
  getSignal(accountId: string, id: string) { return this.arc.getSignal(accountId, id); }
  unblockSignal(accountId: string, signalId: string, arcId: string) { return this.arc.unblockSignal(accountId, signalId, arcId); }

  // Search
  searchArcs(accountId: string, query: string, params: PageParams) { return this.arc.searchArcs(accountId, query, params); }

  // Account
  getAccount(accountId: string) { return this.account.getAccount(accountId); }
  updateAccount(accountId: string, update: Partial<Pick<Account, "name" | "deletionRetentionDays" | "notifications" | "filtering">>) { return this.account.updateAccount(accountId, update); }

  // Views
  listViews(accountId: string) { return this.account.listViews(accountId); }
  getView(accountId: string, id: string) { return this.account.getView(accountId, id); }
  createView(accountId: string, data: CreateViewRequest) { return this.account.createView(accountId, data); }
  updateView(accountId: string, id: string, data: UpdateViewRequest) { return this.account.updateView(accountId, id, data); }
  deleteView(accountId: string, id: string) { return this.account.deleteView(accountId, id); }
  reorderViews(accountId: string, orderedIds: string[]) { return this.account.reorderViews(accountId, orderedIds); }

  // Labels
  listLabels(accountId: string) { return this.account.listLabels(accountId); }
  createLabel(accountId: string, data: CreateLabelRequest) { return this.account.createLabel(accountId, data); }
  updateLabel(accountId: string, id: string, data: UpdateLabelRequest) { return this.account.updateLabel(accountId, id, data); }
  deleteLabel(accountId: string, id: string) { return this.account.deleteLabel(accountId, id); }

  // Rules
  listRules(accountId: string) { return this.account.listRules(accountId); }
  createRule(accountId: string, data: CreateRuleRequest) { return this.account.createRule(accountId, data); }
  updateRule(accountId: string, id: string, data: UpdateRuleRequest) { return this.account.updateRule(accountId, id, data); }
  deleteRule(accountId: string, id: string) { return this.account.deleteRule(accountId, id); }
  reorderRules(accountId: string, orderedIds: string[]) { return this.account.reorderRules(accountId, orderedIds); }

  // Domains
  listDomains(accountId: string) { return this.account.listDomains(accountId); }
  getDomain(accountId: string, id: string) { return this.account.getDomain(accountId, id); }
  createDomain(accountId: string, domain: string) { return this.account.createDomain(accountId, domain); }
  deleteDomain(accountId: string, id: string) { return this.account.deleteDomain(accountId, id); }

  // Email configs
  listEmailConfigs(accountId: string) { return this.account.listEmailConfigs(accountId); }
  getEmailConfig(accountId: string, address: string) { return this.account.getEmailAddressConfig(accountId, address); }
  upsertEmailConfig(config: EmailAddressConfig) { return this.account.upsertEmailConfig(config); }
  deleteEmailConfig(accountId: string, address: string) { return this.account.deleteEmailConfig(accountId, address); }
}
