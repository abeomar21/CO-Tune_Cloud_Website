import React, { useEffect, useRef, useState, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stage, PerspectiveCamera } from "@react-three/drei";
import URDFLoader from "urdf-loader";
import "../../URDFViewer.css";

function Robot({ urdfUrl, joint1, joint2 }) {
    const [robot, setRobot] = useState(null);
    const robotRef = useRef();

    useEffect(() => {
        const loader = new URDFLoader();
        loader.load(urdfUrl, (urdf) => {
            // Rotate 180 degrees around X to flip the model right-side up (motor base on bottom)
            // The previous '0' rotation left it standing on its head.
            urdf.rotation.x = Math.PI;

            // Fix meshes that might look transparent
            urdf.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.material.side = THREE.DoubleSide;
                }
            });

            setRobot(urdf);
        });
    }, [urdfUrl]);

    useFrame(() => {
        if (robotRef.current) {
            // In the URDF we confirmed:
            // armm_joint_1 = arm rotation (yaw) -> mapped to joint1 (theta)
            // pendulum_joint_2 = pendulum rotation (pitch) -> mapped to joint2 (alpha)

            if (robotRef.current.joints["armm_joint_1"]) {
                robotRef.current.joints["armm_joint_1"].setJointValue(joint1);
            }

            if (robotRef.current.joints["pendulum_joint_2"]) {
                // MATLAB alpha_u = 0 is upright. Depending on CAD export, 
                // the joint's 0 might be straight out or down. 
                // We add an offset if it looks weird. For now, try mapping directly:
                robotRef.current.joints["pendulum_joint_2"].setJointValue(-joint2);
            }
        }
    });

    if (!robot) {
        return (
            <mesh>
                <boxGeometry args={[0.5, 0.5, 0.5]} />
                <meshStandardMaterial color="gray" wireframe />
            </mesh>
        ); // Placeholder while loading
    }

    return <primitive ref={robotRef} object={robot} />;
}

export const FurutaURDFViewer = ({
    urdfUrl,
    width = "100%",
    height = "100%",
    joint1 = 0,
    joint2 = 0,
    zoom = 1,
}) => {
    return (
        <div
            className="urdf rotary-urdf-viewer-container"
            style={{
                width: width,
                height: height,
                borderRadius: "10px",
                overflow: "hidden"
            }}
        >
            <Canvas shadows>
                <PerspectiveCamera 
                    makeDefault 
                    position={[0.8 / zoom, 0.7 / zoom, 0.8 / zoom]} 
                    fov={45} 
                />
                <color attach="background" args={["#1a1a1a"]} />

                <ambientLight intensity={0.6} />
                <directionalLight
                    position={[5, 10, 5]}
                    intensity={1.5}
                    castShadow
                    shadow-mapSize={1024}
                />
                <pointLight position={[-5, -5, -5]} intensity={0.5} />

                <Stage
                    environment="city"
                    intensity={0.4}
                    contactShadow
                    shadows
                    adjustCamera={false} // Disable auto camera adjustment to maintain view
                >
                    <Robot urdfUrl={urdfUrl} joint1={joint1} joint2={joint2} />
                </Stage>

                <OrbitControls
                    enablePan={false}
                    minDistance={0.5}
                    maxDistance={3}
                    target={[0, 0.2, 0]}
                />
            </Canvas>
        </div>
    );
};
