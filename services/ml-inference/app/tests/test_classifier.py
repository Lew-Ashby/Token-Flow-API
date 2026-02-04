import pytest
import numpy as np
from sklearn.metrics import accuracy_score, precision_score, recall_score

from app.models.intent_classifier import IntentClassifier, INTENT_LABELS
from app.features import FeatureExtractor

class TestIntentClassifier:
    def setup_method(self):
        self.classifier = IntentClassifier()
        self.extractor = FeatureExtractor()

    def test_heuristic_prediction_dex_trading(self):
        """Test heuristic prediction for DEX trading."""
        features = np.array([5, 10, 5000, 2, 1, 1, 0, 0, 1000, 3])

        intent, confidence = self.classifier.predict(features)

        assert intent == 'trading'
        assert confidence > 0.7

    def test_heuristic_prediction_bridging(self):
        """Test heuristic prediction for bridge transactions."""
        features = np.array([3, 8, 5000, 1, 1, 0, 1, 0, 500, 2])

        intent, confidence = self.classifier.predict(features)

        assert intent == 'bridging'
        assert confidence > 0.8

    def test_heuristic_prediction_simple_transfer(self):
        """Test heuristic prediction for simple transfers."""
        features = np.array([1, 3, 5000, 1, 1, 0, 0, 0, 0, 1])

        intent, confidence = self.classifier.predict(features)

        assert intent == 'transfer'
        assert confidence > 0.8

    def test_heuristic_prediction_arbitrage(self):
        """Test heuristic prediction for arbitrage (multiple swaps)."""
        features = np.array([6, 15, 10000, 4, 2, 1, 0, 0, 2000, 4])

        intent, confidence = self.classifier.predict(features)

        assert intent == 'arbitrage'
        assert confidence > 0.7

    def test_feature_extraction_dex_transaction(self):
        """Test feature extraction for DEX transaction."""
        transaction = {
            'instructions': [
                {
                    'program': 'spl-token',
                    'parsed': {
                        'type': 'transfer',
                        'info': {'amount': '1000000', 'mint': 'token1'}
                    }
                }
            ],
            'accounts': ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'addr1'],
            'fee': 5000
        }

        features = self.extractor.extract_features(transaction)

        assert features.shape == (10,)
        assert features[0] == 1  # num_instructions
        assert features[5] == 1  # has_dex

    def test_classifier_training(self):
        """Test model training with synthetic data."""
        X_train = np.random.rand(200, 10)
        y_train = np.random.choice(INTENT_LABELS, 200)

        self.classifier.train(X_train, y_train)

        assert self.classifier.is_trained is True

        features = np.random.rand(10)
        intent, confidence = self.classifier.predict(features)

        assert intent in INTENT_LABELS
        assert 0 <= confidence <= 1

    def test_model_save_and_load(self, tmp_path):
        """Test model persistence."""
        X_train = np.random.rand(100, 10)
        y_train = np.random.choice(INTENT_LABELS[:3], 100)

        self.classifier.train(X_train, y_train)

        self.classifier.model_path = tmp_path / "test_model.joblib"
        self.classifier.scaler_path = tmp_path / "test_scaler.joblib"
        self.classifier.save()

        new_classifier = IntentClassifier()
        new_classifier.model_path = tmp_path / "test_model.joblib"
        new_classifier.scaler_path = tmp_path / "test_scaler.joblib"
        loaded = new_classifier.load()

        assert loaded is True
        assert new_classifier.is_trained is True

    def test_accuracy_threshold(self):
        """Test that trained model achieves minimum accuracy."""
        np.random.seed(42)

        X_train = np.random.rand(500, 10)
        y_train = np.array(['trading' if x[5] > 0.5 else 'transfer' for x in X_train])

        self.classifier.train(X_train, y_train)

        X_test = np.random.rand(100, 10)
        y_test = np.array(['trading' if x[5] > 0.5 else 'transfer' for x in X_test])

        predictions = []
        for features in X_test:
            intent, _ = self.classifier.predict(features)
            predictions.append(intent)

        accuracy = accuracy_score(y_test, predictions)

        assert accuracy > 0.70, f"Accuracy {accuracy} below threshold"

    def test_batch_prediction_consistency(self):
        """Test that batch predictions are consistent."""
        features = np.random.rand(10)

        intent1, conf1 = self.classifier.predict(features)
        intent2, conf2 = self.classifier.predict(features)

        assert intent1 == intent2
        assert abs(conf1 - conf2) < 0.001

if __name__ == '__main__':
    pytest.main([__file__, '-v'])
