// The company's Squideo Academy, on its page: plan, usage, what is due and the
// invoices, with the same window for raising an invoice as the Academies page.
//
// Shown only when an academy is linked to this company. Most companies have
// none, and an empty card on every company page would be noise; linking starts
// from the Academies page, where every unlinked academy is listed.
import React, { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../../theme.js';
import { api } from '../../api.js';
import { Card } from './Card.jsx';
import { AcademyPanel } from './AcademyPanel.jsx';
import { AcademyInvoiceModal, LinkCompanyModal } from './academyUi.jsx';

export function CompanyAcademyCard({ companyId }) {
  const [data, setData] = useState(null);
  const [invoicing, setInvoicing] = useState(null);
  const [linking, setLinking] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!companyId) return;
    api.get('/api/crm/companies/' + encodeURIComponent(companyId) + '/academy')
      .then((r) => { setData(r); setError(null); })
      .catch(() => setData(null));
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  if (!data || !data.connected || !(data.academies || []).length) return null;

  const changed = () => { setInvoicing(null); setLinking(null); load(); };
  const unmark = async (row, academy) => {
    try {
      await api.post(`/api/crm/academies/${academy.id}/unmark`, { rowId: row.id });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <Card
        title="Squideo Academy"
        count={data.academies.length > 1 ? data.academies.length : undefined}
        action={<a href="#/academies" style={{ fontSize: 12 }}>All academies</a>}
      >
        {error && <p role="alert" style={{ color: '#B91C1C', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}
        <div style={{ display: 'grid', gap: 18 }}>
          {data.academies.map((a, i) => (
            <div key={a.id} style={i ? { borderTop: '1px solid ' + BRAND.border, paddingTop: 14 } : undefined}>
              <AcademyPanel
                academy={a}
                canInvoice={data.canInvoice}
                canLink={data.canLink}
                onInvoice={setInvoicing}
                onLink={setLinking}
                onUnmark={unmark}
                onChanged={load}
                showCompany={false}
              />
            </div>
          ))}
        </div>
      </Card>
      {invoicing && <AcademyInvoiceModal academy={invoicing} onClose={() => setInvoicing(null)} onDone={changed} />}
      {linking && <LinkCompanyModal academy={linking} onClose={() => setLinking(null)} onDone={changed} />}
    </div>
  );
}
