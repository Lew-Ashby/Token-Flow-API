import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
import joblib
from pathlib import Path
from typing import Tuple

INTENT_LABELS = [
    'trading',           # DEX swaps
    'yield_farming',     # LP deposits, staking
    'arbitrage',         # Multi-DEX same-token trades
    'bridging',          # Cross-chain transfers
    'liquidation',       # Lending protocol liquidations
    'governance',        # DAO voting, staking for governance
    'transfer',          # Simple wallet-to-wallet
    'unknown'
]

class IntentClassifier:
    def __init__(self):
        self.scaler = StandardScaler()
        self.model = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            min_samples_split=5,
            random_state=42
        )
        self.is_trained = False
        self.model_path = Path(__file__).parent / 'saved_model.joblib'
        self.scaler_path = Path(__file__).parent / 'saved_scaler.joblib'

    def train(self, X_train: np.ndarray, y_train: np.ndarray):
        X_scaled = self.scaler.fit_transform(X_train)
        self.model.fit(X_scaled, y_train)
        self.is_trained = True

    def predict(self, features: np.ndarray) -> Tuple[str, float]:
        if not self.is_trained:
            return self._heuristic_prediction(features)

        X_scaled = self.scaler.transform(features.reshape(1, -1))
        probas = self.model.predict_proba(X_scaled)[0]
        predicted_idx = np.argmax(probas)

        return INTENT_LABELS[predicted_idx], float(probas[predicted_idx])

    def _heuristic_prediction(self, features: np.ndarray) -> Tuple[str, float]:
        transfer_count = features[3]
        has_dex = features[5]
        has_bridge = features[6]
        has_lending = features[7]

        if has_bridge > 0:
            return 'bridging', 0.85

        if has_dex > 0:
            if transfer_count > 2:
                return 'arbitrage', 0.75
            else:
                return 'trading', 0.80

        if has_lending > 0:
            return 'yield_farming', 0.70

        if transfer_count == 1:
            return 'transfer', 0.90

        return 'unknown', 0.50

    def save(self):
        if self.is_trained:
            joblib.dump(self.model, self.model_path)
            joblib.dump(self.scaler, self.scaler_path)

    def load(self):
        if self.model_path.exists() and self.scaler_path.exists():
            self.model = joblib.load(self.model_path)
            self.scaler = joblib.load(self.scaler_path)
            self.is_trained = True
            return True
        return False
