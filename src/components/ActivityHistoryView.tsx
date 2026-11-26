import { useState } from 'react';
import { History, Sparkles, User } from 'lucide-react';
import type { ActivityLog, AiActionRecord } from '../types';
import { formatTimestamp } from '../utils/foodUtils';

interface ActivityHistoryViewProps {
  logs: ActivityLog[];
  aiActions: AiActionRecord[];
}

export function ActivityHistoryView({ logs, aiActions }: ActivityHistoryViewProps) {
  const [filter, setFilter] = useState<'all' | 'inventory' | 'donations' | 'ai'>('all');

  const filteredLogs = logs.filter((log) => {
    if (filter === 'all') return true;
    if (filter === 'ai') return log.source === 'ai' || log.action === 'ai_action';
    if (filter === 'donations') return log.action.startsWith('donation_');
    return (
      log.action.startsWith('food_') || log.action.startsWith('quantity_')
    );
  });

  function formatActionLabel(action: string): string {
    return action
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
            Consumption & Activity History
          </h1>
          <p className="text-sm text-[#5A6A60]">
            Persistent cloud record of every food update, donation milestone, and Zero Crumbs AI action.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#EFEFE9] rounded-xl w-full sm:w-fit overflow-x-auto no-scrollbar">
          {(
            [
              { key: 'all', label: 'All Activity' },
              { key: 'inventory', label: 'Inventory' },
              { key: 'donations', label: 'Donations' },
              { key: 'ai', label: 'AI Actions' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                filter === tab.key
                  ? 'bg-white text-[#1A2820] shadow-xs'
                  : 'text-[#5A6A60] hover:text-[#1A2820]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Activity Feed */}
        <div className="lg:col-span-2 bg-white border border-[#E5E7E2] rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#ECEEE8] flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#1A2820]">Activity Timeline</h2>
            <span className="font-mono text-xs tabular-nums text-[#5A6A60]">
              {filteredLogs.length} events
            </span>
          </div>

          {filteredLogs.length === 0 ? (
            <div className="p-10 text-center">
              <History className="w-7 h-7 text-[#6B7A70] mx-auto mb-2.5" />
              <p className="text-sm font-medium text-[#1A2820] mb-1">No activity recorded yet</p>
              <p className="text-xs text-[#5A6A60]">
                Actions you or Zero Crumbs AI take will be saved here automatically.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#ECEEE8]">
              {filteredLogs.map((log) => (
                <div key={log.id} className="p-4 sm:px-5 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        log.source === 'ai'
                          ? 'bg-[#FBE8DC] text-[#7D3A24]'
                          : 'bg-[#EEF3EC] text-[#1B4332]'
                      }`}
                    >
                      {log.source === 'ai' ? (
                        <Sparkles className="w-4 h-4" />
                      ) : (
                        <User className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#1A2820]">
                        {formatActionLabel(log.action)} ·{' '}
                        <span className="font-semibold">{log.itemName}</span>
                      </p>
                      <p className="text-xs text-[#4F5E55] mt-0.5">{log.details}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[11px] font-mono tabular-nums text-[#5A6A60]">
                      {formatTimestamp(log.createdAt)}
                    </p>
                    <p className="text-[11px] text-[#6B7A70]">
                      {log.source === 'ai' ? 'Zero Crumbs AI' : 'Manual'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI Action Audit Trail */}
        <div className="bg-white border border-[#E5E7E2] rounded-2xl overflow-hidden h-fit">
          <div className="px-5 py-4 border-b border-[#ECEEE8] flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#1A2820]">
              AI Execution Records
            </h2>
            <span className="font-mono text-xs tabular-nums text-[#5A6A60]">
              {aiActions.length}
            </span>
          </div>

          {aiActions.length === 0 ? (
            <div className="p-6 text-center text-xs text-[#5A6A60]">
              Confirmed and cancelled Zero Crumbs AI actions appear here.
            </div>
          ) : (
            <div className="divide-y divide-[#ECEEE8] max-h-[540px] overflow-y-auto">
              {aiActions.map((act) => (
                <div key={act.id} className="p-4 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#1A2820] capitalize">
                      {act.actionType.replace(/_/g, ' ')}
                    </span>
                    <span
                      className={`text-[11px] font-medium capitalize ${
                        act.status === 'confirmed'
                          ? 'text-[#1B4332]'
                          : act.status === 'failed'
                            ? 'text-[#B83B3B]'
                            : 'text-[#6B7A70]'
                      }`}
                    >
                      {act.status}
                    </span>
                  </div>
                  <p className="text-xs text-[#4F5E55]">{act.summary}</p>
                  {act.errorMessage && (
                    <p className="text-[11px] text-[#B83B3B]">{act.errorMessage}</p>
                  )}
                  <p className="text-[11px] font-mono tabular-nums text-[#6B7A70]">
                    {formatTimestamp(act.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
