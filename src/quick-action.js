/**
 * @file Represents Salesforce QuickAction
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */
import Connection from './connection';
import type { DescribeQuickActionDetailResult } from './types';

/**
 * type definitions
 */
export type QuickActionDefaultValues = { [string]: ?any };

export type QuickActionResult = {
  id: string,
  feedItemIds: ?string[],
  success: boolean,
  created: boolean,
  contextId: string,
  errors: Object[],
};

/**
 * A class for quick action
 */
export default class QuickAction {
  _conn: Connection;
  _path: string;

  /**
   *
   */
  constructor(conn: Connection, path: string) {
    this._conn = conn;
    this._path = path;
  }

  /**
   * Describe the action's information (including layout, etc.)
   */
  async describe(): Promise<DescribeQuickActionDetailResult> {
    const url = `${this._path}/describe`;
    const body = await this._conn.request(url);
    return (body : DescribeQuickActionDetailResult);
  }

  /**
   * Retrieve default field values in the action (for given record, if specified)
   */
  async defaultValues(contextId?: string): Promise<QuickActionDefaultValues> {
    let url = `${this._path}/defaultValues`;
    if (contextId) {
      url += `/${contextId}`;
    }
    const body = await this._conn.request(url);
    return (body : { [string]: ?any });
  }

  /**
   * Execute the action for given context Id and record information
   */
  async execute(contextId, record): Promise<QuickActionResult> {
    const requestBody = { contextId, record };
    const resBody = await this._conn.requestPost(this._path, requestBody);
    return (resBody : QuickActionResult);
  }
}