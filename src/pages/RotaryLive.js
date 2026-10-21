import { useState, useEffect, useRef } from "react";
import React from "react";
import {
  IoTDataPlaneClient,
  PublishCommand,
} from "@aws-sdk/client-iot-data-plane";
import { fetchAuthSession } from "@aws-amplify/auth";
import { Buffer } from "buffer";
import "./RotarySimPage.css";
import "./SuspensionSimPage.css"; // Use simulation styling
import { PubSub } from "@aws-amplify/pubsub";
import { IoTClient, AttachPolicyCommand } from "@aws-sdk/client-iot";
import useQueueStatus from "./Queue3";
import { Helmet } from "react-helmet-async";
import Loading from "../components/loading";
import { useNavigate } from "react-router-dom";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import {
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import LiveVideoPlayer from "./Video";
import { lqrJS } from "../controllers/LQR/lqr_calc";
import Modal from "../components/ModalExp";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

// Constants from Furuta Sim
const mp = 0.02, Lp = 0.134, Lr = 0.185;
const Jp = 2.9927e-5, Jr = 2.852e-3;
const Br = 0.003, Bp = 0.00005, g = 9.81;
const Jr_t = Jr + mp * Lr * Lr;
const Jp_t = Jp + 0.25 * mp * Lp * Lp;
const Jx = 0.5 * mp * Lp * Lr;
const detM = Jr_t * Jp_t - Jx * Jx;

const A = [
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [0, (Jx * 0.5 * mp * Lp * g) / detM, -(Jp_t * Br) / detM, -(Jx * Bp) / detM],
  [0, (Jr_t * 0.5 * mp * Lp * g) / detM, -(Jx * Br) / detM, -(Jr_t * Bp) / detM],
];
const B = [[0], [0], [Jp_t / detM], [Jx / detM]];

// ---- Chart helper config ----
const CHART_OPTIONS = (yLabel) => ({
  animation: false,
  responsive: true,
  plugins: {
    legend: { position: "top" },
  },
  scales: {
    x: {
      type: "category",
      title: { display: true, text: "Time (s)", color: "#333" },
      min: 0,
    },
    y: {
      title: { display: true, text: yLabel, color: "#333" },
      ticks: { color: "#333" },
    },
  },
});

function makeDataset(label, data, color) {
  return {
    label,
    data,
    borderColor: color,
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.1,
  };
}

function RotaryLive() {
  const [thetaData, setThetaData] = useState([]);
  const [alphaData, setAlphaData] = useState([]);
  const [thetaDotData, setThetaDotData] = useState([]);
  const [alphaDotData, setAlphaDotData] = useState([]);
  const [timestamps, setTimestamps] = useState([]);
  const [isButtonsDisabled, setIsButtonsDisabled] = useState(false);
  const [message, setMessage] = useState(null);
  const [kValues, setKValues] = useState([0, 0, 0, 0]);
  
  // Start with 0 defaults
  const [QValues, setQValues] = useState({
    Q00: 0, Q01: 0, Q02: 0, Q03: 0,
    Q10: 0, Q11: 0, Q12: 0, Q13: 0,
    Q20: 0, Q21: 0, Q22: 0, Q23: 0,
    Q30: 0, Q31: 0, Q32: 0, Q33: 0,
  });
  const [RValue, setRValue] = useState(0);

  const [credentials, setCredentials] = useState(null);
  const [iotClient, setIoTClient] = useState(null);
  const REGION = "eu-west-3";
  const TABLE_NAME = "RotaryLQRParameters";

  const { isAllowed, identityId, position, timeRemaining, isLoading } = useQueueStatus();
  const navigate = useNavigate();

  useEffect(() => {
    const initializeIoTClient = async () => {
      try {
        const session = await fetchAuthSession({ forceRefresh: false });
        const fetchedCredentials = session.credentials;
        const policyClient = new IoTClient({ region: REGION, credentials: fetchedCredentials });
        const policyCommand = new AttachPolicyCommand({ policyName: "IoTPolicy", target: session.identityId });
        await policyClient.send(policyCommand);
        setCredentials(fetchedCredentials);
        setIoTClient(new IoTDataPlaneClient({ region: REGION, credentials: fetchedCredentials }));
      } catch (err) {
        console.error("Error initializing IoT client:", err);
      }
    };
    initializeIoTClient();
  }, []);

  useEffect(() => {
    if (!credentials) return;
    const pubsub = new PubSub({
      region: REGION,
      credentials: credentials,
      endpoint: "wss://a3c1jrwyyxkjx6-ats.iot.eu-west-3.amazonaws.com/mqtt",
    });
    const subscription = pubsub.subscribe({ topics: "ROTARY/Data" }).subscribe({
      next: (data) => {
        setMessage(data);
        setThetaData((prev) => [...prev, data.theta]);
        setAlphaData((prev) => [...prev, data.alpha]);
        setThetaDotData((prev) => [...prev, data.theta_dot]);
        setAlphaDotData((prev) => [...prev, data.alpha_dot]);
        setTimestamps((prev) => [...prev, (prev.length * 0.1).toFixed(1)]);
      },
      error: (error) => console.error("Subscription error:", error),
    });
    return () => subscription.unsubscribe();
  }, [credentials]);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (name === "R") {
      setRValue(value);
    } else {
      setQValues((prev) => ({ ...prev, [name]: value }));
    }
  };

  const computeKValues = () => {
    const Q = [
      [parseFloat(QValues.Q00) || 0, parseFloat(QValues.Q01) || 0, parseFloat(QValues.Q02) || 0, parseFloat(QValues.Q03) || 0],
      [parseFloat(QValues.Q10) || 0, parseFloat(QValues.Q11) || 0, parseFloat(QValues.Q12) || 0, parseFloat(QValues.Q13) || 0],
      [parseFloat(QValues.Q20) || 0, parseFloat(QValues.Q21) || 0, parseFloat(QValues.Q22) || 0, parseFloat(QValues.Q23) || 0],
      [parseFloat(QValues.Q30) || 0, parseFloat(QValues.Q31) || 0, parseFloat(QValues.Q32) || 0, parseFloat(QValues.Q33) || 0],
    ];
    const R = [[parseFloat(RValue) || 0]];
    try {
      const K = lqrJS(A, B, Q, R);
      setKValues(K[0]);
      return K[0];
    } catch (error) {
      console.error("LQR computation error:", error);
      alert("LQR failed: " + error.message);
      return [0, 0, 0, 0];
    }
  };

  const handleUseOurParameters = () => {
    setQValues({
      Q00: 10, Q01: 0, Q02: 0, Q03: 0,
      Q10: 0, Q11: 500, Q12: 0, Q13: 0,
      Q20: 0, Q21: 0, Q22: 1, Q23: 0,
      Q30: 0, Q31: 0, Q32: 0, Q33: 20,
    });
    setRValue(0.05);
  };

  const saveLQRParameters = async (K, timestamp) => {
    if (!credentials) return;
    const dbClient = new DynamoDBClient({ region: REGION, credentials });
    try {
      const params = {
        TableName: TABLE_NAME,
        Item: {
          identityId: { S: identityId },
          timestamp: { N: timestamp },
          Q00: { N: (QValues.Q00 || 0).toString() },
          Q11: { N: (QValues.Q11 || 0).toString() },
          Q22: { N: (QValues.Q22 || 0).toString() },
          Q33: { N: (QValues.Q33 || 0).toString() },
          R: { N: (RValue || 0).toString() },
          K0: { N: K[0].toString() },
          K1: { N: K[1].toString() },
          K2: { N: K[2].toString() },
          K3: { N: K[3].toString() },
        },
      };
      await dbClient.send(new PutItemCommand(params));
    } catch (error) {
      console.error("Error saving LQR parameters:", error);
    }
  };

  const sendCommand = async () => {
    if (!iotClient) return;
    setIsButtonsDisabled(true);
    const K = computeKValues();
    const timestamp = Date.now().toString();
    const payload = { id: identityId, timestamp, message: K, work: 1 };
    try {
      const publishParams = {
        topic: "ROTARY/Parameters",
        qos: 0,
        payload: Buffer.from(JSON.stringify(payload)),
      };
      await iotClient.send(new PublishCommand(publishParams));
      await saveLQRParameters(K, timestamp);
      setTimeout(() => setIsButtonsDisabled(false), 5000);
    } catch (err) {
      console.error("Error sending command:", err);
      setIsButtonsDisabled(false);
    }
  };

  const buildChartData = (label, dataArray, color) => {
    // Decimate for charting performance to prevent lag over 5 minutes
    const step = Math.max(1, Math.floor(timestamps.length / 500));
    return {
      labels: timestamps.filter((_, i) => i % step === 0),
      datasets: [makeDataset(label, dataArray.filter((_, i) => i % step === 0), color)],
    };
  };

  if (isLoading) return <Loading position={position} />;
  if (position > 1) return <Loading position={position} />;

  return (
    <div className="sim-page-wrapper">
      <Helmet><title>Rotary Inverted Pendulum Live</title></Helmet>
      <h1 className="sim-page-title">Rotary Inverted Pendulum</h1>
      <Modal />

      <div style={{
          position: "fixed", top: "90px", right: "1rem", zIndex: 1100,
          background: "var(--card-bg)", border: "1px solid var(--card-border)",
          borderRadius: "8px", padding: "0.4rem 0.9rem",
          fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)",
          whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(0,0,0,0.3)"
        }}>
          ⏱ {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')} remaining
        </div>

      <div className="sim-container">
        {/* ---- LQR Input Panel ---- */}
        <div className="sim-left-panel">
          <h3>LQR Parameters</h3>
          <div className="matrix-input-section" style={{ display: 'flex', gap: '1.5rem', width: '100%', justifyContent: 'center' }}>
            <div className="q-matrix-container">
              <h3>Q Matrix (4×4)</h3>
              <p style={{ fontSize: "0.78em", color: "var(--text-secondary)", margin: "0 0 8px" }}>
                State order: θ (arm angle) | α (pendulum error) | θ̇ | α̇
              </p>
              <div className="q-matrix-grid">
                <div className="matrix-label" />
                {["θ", "α", "θ̇", "α̇"].map((l, i) => <div className="matrix-label" key={i}>{l}</div>)}
                {[...Array(4)].map((_, row) => (
                  <React.Fragment key={row}>
                    <div className="matrix-label">{["θ", "α", "θ̇", "α̇"][row]}</div>
                    {[...Array(4)].map((_, col) => (
                      <div className="input-group" key={col}>
                        <input
                          type="number"
                          name={`Q${row}${col}`}
                          value={QValues[`Q${row}${col}`]}
                          onChange={handleInputChange}
                          step="0.1"
                        />
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="r-matrix-container">
              <h4>R Value (torque penalty)</h4>
              <div className="input-group">
                <input type="number" name="R" value={RValue} onChange={handleInputChange} step="0.01" />
              </div>
            </div>
            <button onClick={sendCommand} className={`btn ${isButtonsDisabled ? 'btn-danger' : 'btn-primary'} start-sim-btn`} disabled={isButtonsDisabled} style={{ marginTop: '1rem', width: '100%', maxWidth: '300px' }}>
              {isButtonsDisabled ? "Processing..." : "Start Live"}
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "center", marginTop: "1rem" }}>
            <button onClick={handleUseOurParameters} className="btn btn-secondary start-sim-btn" style={{ backgroundColor: "#ff9f43", fontSize: "0.9rem", padding: "0.5rem" }}>
              Use Recommended Parameters
            </button>
            <button onClick={() => navigate('/RotaryProgress')} className="btn btn-secondary start-sim-btn" style={{ fontSize: "0.9rem", padding: "0.5rem" }}>
              Track your Progress
            </button>
            <button onClick={() => navigate('/Main')} className="btn btn-secondary start-sim-btn" style={{ fontSize: "0.9rem", padding: "0.5rem" }}>
              Back to Main
            </button>
          </div>
        </div>

        {/* Video Player */}
        <div className="sim-right-panel">
          <div className="viewer-header">
            <h3>Live Camera Feed</h3>
          </div>
          <div className="viewer-container" style={{ minHeight: "400px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <LiveVideoPlayer />
          </div>
        </div>
      </div>

        <div className="message-box" style={{ marginTop: '20px', marginBottom: "40px", backgroundColor: "var(--bg-secondary)", padding: "15px", borderRadius: "8px", border: "1px solid var(--card-border)" }}>
          <h2 style={{ fontSize: "1.2em", marginBottom: "10px" }}>Live Sensor Data</h2>
          {message ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px' }}>
              <p><strong>θ:</strong> {message.theta?.toFixed(3)}</p>
              <p><strong>α:</strong> {message.alpha?.toFixed(3)}</p>
              <p><strong>θ̇:</strong> {message.theta_dot?.toFixed(3)}</p>
              <p><strong>α̇:</strong> {message.alpha_dot?.toFixed(3)}</p>
            </div>
          ) : <p>Waiting for hardware data...</p>}
        </div>

        {/* Charts: 4 distinct graphs like Simulation */}
        <div className="chart-container">
          <div className="chart">
            <h3>Arm Angle θ (rad)</h3>
            <Line data={buildChartData("θ", thetaData, "#36A2EB")} options={CHART_OPTIONS("θ (rad)")} />
          </div>
          <div className="chart">
            <h3>Pendulum Error α (rad)</h3>
            <Line data={buildChartData("α", alphaData, "#FF6384")} options={CHART_OPTIONS("α (rad)")} />
          </div>
        </div>

        <div className="chart-container" style={{ marginBottom: "60px" }}>
          <div className="chart">
            <h3>Arm Velocity θ̇ (rad/s)</h3>
            <Line data={buildChartData("θ̇", thetaDotData, "#4BC0C0")} options={CHART_OPTIONS("θ̇ (rad/s)")} />
          </div>
          <div className="chart">
            <h3>Pendulum Velocity α̇ (rad/s)</h3>
            <Line data={buildChartData("α̇", alphaDotData, "#FFCE56")} options={CHART_OPTIONS("α̇ (rad/s)")} />
          </div>
        </div>

    </div>
  );
}

export default RotaryLive;
