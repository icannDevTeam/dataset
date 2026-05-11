import Head from 'next/head';
import AdminLayout from '../../../components/v2/AdminLayout';
import AuditTrailPanel from '../../../components/v2/admin/AuditTrailPanel';

export default function SystemAuditPage() {
  return (
    <AdminLayout title="System Audit" subtitle="Every mutating action across the system">
      <Head><title>System Audit · Admin</title></Head>
      <AuditTrailPanel />
    </AdminLayout>
  );
}
