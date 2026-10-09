import InterviewPage from './interview/InterviewPage';
import ReportPage from './report/ReportPage';
import StorePage from './store/StorePage';

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/shop')) return <StorePage />;
  if (path.startsWith('/report')) return <ReportPage />;
  return <InterviewPage />;
}
